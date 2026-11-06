import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { config, production } from './config.js';
import { db, recordEvent, createBackup } from './db.js';
import { AppError, assert, hashPassword, verifyPassword, randomToken, hashToken, now } from './security.js';
import { can, publicUser, getSettings, getCredentials, saveCredentials, updateOperational, dashboard, queryOrderRows, getOrder, lookupOrder, assignCN, saveVerification, packOrder, dispatchOrder, checkPending, resolveReview, rawOrder, localDay, dayBounds, rollPending, pendingHistory, type Row } from './operations.js';
import { testShopify, syncOrders, isSyncing, registerWebhooks, receiveWebhook, fetchShopifyOrder, retrySync, processJobs } from './shopify.js';
import { upsertShopifyOrder } from './operations.js';
import type { Permission, User } from '../shared/types.js';

const COOKIE = 'mettwear_session';
const clients = new Map<Response, User>();
let broadcastTimer: NodeJS.Timeout | undefined;
export function broadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => { for (const [response] of clients) response.write(`event: change\ndata: {}\n\n`); }, 180);
}
let rolloverDay = '';
export function ensureRollover() { const day = localDay(); if (day !== rolloverDay) { rollPending(day); rolloverDay = day; broadcast(); } }
const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve(fn(req, res)).catch(next); };
const idParam = (req: Request) => String(req.params.id);
const passwordSchema = z.string().min(12, 'Use a password with at least 12 characters.').max(128);
const emailSchema = z.string().trim().email().max(254).transform(s => s.toLowerCase());
const nameSchema = z.string().trim().min(2).max(80);
const roleSchema = z.enum(['owner', 'supervisor', 'staff']);
const dummyHash = hashPassword(randomToken());
function sessionUser(req: Request) {
  const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`));
  const token = cookie?.slice(COOKIE.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = db.prepare('SELECT u.*,s.csrf,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1').get(hashToken(token), now()) as Row;
  return row ? { user: publicUser(row), csrf: row.csrf as string, tokenHash: row.token_hash as string } : null;
}
function startSession(req: Request, res: Response, user: User) {
  const token = randomToken(), csrf = randomToken();
  const expiry = new Date(Date.now() + 12 * 3600000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now());
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at) VALUES (?,?,?,?,?)').run(hashToken(token), user.id, csrf, expiry, now());
  res.cookie(COOKIE, token, { httpOnly: true, secure: req.secure || production, sameSite: 'strict', maxAge: 12 * 3600000, path: '/' });
  return { user, csrf };
}
function requireUser(req: Request, permission?: Permission) {
  const auth = resLocal(req);
  assert(auth, 401, 'Sign in to continue.');
  if (permission) assert(can(auth.user, permission), 403, 'Your role does not have permission for this action.');
  return auth;
}
const resLocal = (req: Request) => req.res?.locals.auth as { user: User; csrf: string; tokenHash: string } | null;
const filters = (req: Request) => ({ q: String(req.query.q || ''), status: String(req.query.status || ''), courier: String(req.query.courier || ''), from: String(req.query.from || ''), to: String(req.query.to || ''), pendingDay: String(req.query.pendingDay || ''), page: Number(req.query.page || 1), pageSize: Number(req.query.pageSize || 25) });
const versionBody = z.object({ version: z.number().int().positive() });
function eventFilter(req: Request, user: User) {
  const f = filters(req); const clauses: string[] = []; const params: any[] = [];
  const actor = can(user, 'activity') ? String(req.query.actor || '') : user.id;
  if (actor) { clauses.push('e.actor_id=?'); params.push(actor); }
  if (String(req.query.type || '')) { clauses.push('e.type=?'); params.push(String(req.query.type)); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.from || '')) { clauses.push('e.created_at>=?'); params.push(dayBounds(f.from!).start); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.to || '')) { clauses.push('e.created_at<?'); params.push(dayBounds(f.to!).end); }
  if (f.q) { clauses.push('(e.actor_name LIKE ? OR e.type LIKE ? OR o.name LIKE ?)'); const q = `%${f.q.slice(0,120)}%`; params.push(q,q,q); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export function createApi() {
  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      const expected = config.publicUrl || `${req.protocol}://${req.get('host')}`;
      if ((origin && origin !== expected) || req.get('X-Mettwear-Client') !== 'web') return next(new AppError(403, 'Request origin or client verification failed.'));
    }
    res.locals.auth = sessionUser(req);
    next();
  });
  api.get('/health', (_req, res) => { res.json({ status: 'ok', service: 'Mettwear Operations' }); });
  api.get('/session', (req, res) => {
    const auth = res.locals.auth;
    const setupRequired = !(db.prepare('SELECT count(*) AS n FROM users').get() as Row).n;
    res.json({ user: auth?.user || null, csrf: auth?.csrf || null, setupRequired, setupKeyRequired: production || !!config.setupToken, brand: 'Mettwear' });
  });
  api.post('/setup', rateLimit({ windowMs: 15 * 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }), asyncRoute(async (req, res) => {
    const input = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema, setupKey: z.string().max(200).optional() }).parse(req.body);
    if (production || config.setupToken) {
      const expected = hashToken(config.setupToken); const supplied = hashToken(input.setupKey || '');
      assert(crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)), 403, 'The private setup key is incorrect.');
    }
    const hash = await hashPassword(input.password);
    const user = db.transaction(() => {
      assert(!(db.prepare('SELECT count(*) AS n FROM users').get() as Row).n, 409, 'This workspace is already set up. Sign in instead.');
      const id = crypto.randomUUID(); const at = now();
      db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)').run(id, input.name, input.email, hash, 'owner', at);
      recordEvent(null, { id, name: input.name }, 'WORKSPACE_CREATED');
      return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id) as Row);
    })();
    res.status(201).json(startSession(req, res, user));
  }));
  api.post('/login', rateLimit({ windowMs: 15 * 60000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' } }), asyncRoute(async (req, res) => {
    const input = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).parse(req.body);
    const row = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(input.email) as Row;
    const valid = await verifyPassword(input.password, row?.password_hash || await dummyHash);
    assert(row && valid, 401, 'Email or password is incorrect.');
    db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(now(), row.id);
    const user = publicUser(row); recordEvent(null, user, 'USER_SIGNED_IN');
    res.json(startSession(req, res, user));
  }));
  api.use((req, _res, next) => {
    const auth = resLocal(req); assert(auth, 401, 'Your session has expired. Sign in again.');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) assert(req.get('X-CSRF-Token') === auth.csrf, 403, 'Security token expired. Refresh and try again.');
    next();
  });
  api.post('/logout', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(resLocal(req)!.tokenHash);
    res.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'strict', secure: req.secure || production }); res.json({ ok: true });
  });
  api.get('/events', (req, res) => {
    const user = resLocal(req)!.user;
    const count = [...clients.values()].filter(u => u.id === user.id).length;
    assert(count < 8, 429, 'Too many live connections. Close another tab.');
    res.set({ 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-cache, no-transform' });
    res.flushHeaders(); res.write('event: ready\ndata: {}\n\n'); clients.set(res, user);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000);
    req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
  });
  api.get('/meta', (_req, res) => { const settings = getSettings(); res.json({ couriers: settings.couriers, timezone: settings.timezone, cutoff: settings.cutoff, connected: settings.connected, allowCOD: settings.allowCOD }); });
  api.get('/dashboard', (_req, res) => { ensureRollover(); res.json({ ...dashboard(resLocal(_req)!.user), syncing: isSyncing() }); });
  api.get('/orders', (req, res) => { ensureRollover(); res.json(queryOrderRows(filters(req), resLocal(req)!.user)); });
  api.get('/orders/:id', (req, res) => res.json(getOrder(idParam(req), resLocal(req)!.user)));
  api.get('/lookup', (req, res) => { const code = String(req.query.code || '').trim(); assert(code.length >= 3 && code.length <= 120, 400, 'Enter a complete order number or CN.'); res.json(lookupOrder(code, resLocal(req)!.user)); });
  api.post('/orders/:id/cn', (req, res) => {
    const input = versionBody.extend({ cn: z.string().min(4).max(100), courier: z.string().min(1).max(60), trackingUrl: z.string().max(1000).optional() }).parse(req.body);
    res.json(assignCN(idParam(req), input, resLocal(req)!.user));
  });
  api.post('/orders/:id/verify', (req, res) => {
    const input = versionBody.extend({ items: z.array(z.object({ id: z.string(), quantity: z.number().int().min(0), checked: z.boolean() })).min(1).max(1000) }).parse(req.body);
    assert(can(resLocal(req)!.user, 'verify'), 403, 'Packing permission required.'); res.json(saveVerification(idParam(req), input, resLocal(req)!.user));
  });
  api.post('/orders/:id/pack', (req, res) => { const input = versionBody.parse(req.body); assert(can(resLocal(req)!.user, 'pack'), 403, 'Packing permission required.'); res.json(packOrder(idParam(req), input.version, resLocal(req)!.user)); });
  api.post('/orders/:id/dispatch', (req, res) => { const input = versionBody.extend({ handoverConfirmed: z.boolean() }).parse(req.body); assert(can(resLocal(req)!.user, 'dispatch'), 403, 'Dispatch permission required.'); const order = dispatchOrder(idParam(req), input, resLocal(req)!.user); void processJobs().then(broadcast); res.json(order); });
  api.post('/orders/:id/check', (req, res) => { const input = z.object({ note: z.string().min(3).max(1000), stillOutstanding: z.boolean() }).parse(req.body); res.json(checkPending(idParam(req), input, resLocal(req)!.user)); });
  api.post('/orders/:id/reconcile', asyncRoute(async (req, res) => {
    const input = versionBody.extend({ resolution: z.enum(['dispatched', 'outstanding']), evidence: z.string().min(8).max(1000) }).parse(req.body);
    const auth = resLocal(req)!; assert(can(auth.user, 'reconcile'), 403, 'Only the owner can reconcile orders.');
    if (input.resolution === 'dispatched') {
      const live = await fetchShopifyOrder(idParam(req)); upsertShopifyOrder(live, auth.user, 'Pre-reconciliation Shopify refresh');
      input.version = rawOrder(idParam(req))!.version;
    }
    res.json(resolveReview(idParam(req), input, auth.user));
  }));
  api.post('/orders/:id/refresh', asyncRoute(async (req, res) => {
    const auth = resLocal(req)!; assert(rawOrder(idParam(req)), 404, 'Import this order from Shopify first.');
    const order = await fetchShopifyOrder(idParam(req)); upsertShopifyOrder(order, auth.user, 'Manual Shopify refresh'); res.json(getOrder(idParam(req), auth.user));
  }));
  api.post('/orders/:id/retry-sync', (req, res) => { const auth = requireUser(req, 'import'); retrySync(idParam(req), auth.user); void processJobs().then(broadcast); res.json({ ok: true }); });
  api.get('/pending/history', (req, res) => { ensureRollover(); res.json(pendingHistory(Math.max(1, Number(req.query.page) || 1), Math.min(100, Math.max(1, Number(req.query.pageSize) || 30)), String(req.query.day || ''))); });
  api.get('/activity', (req, res) => {
    const auth = resLocal(req)!; const page = Math.max(1, Number(req.query.page) || 1); const size = 30;
    const { where, params } = eventFilter(req, auth.user);
    const total = (db.prepare(`SELECT count(*) AS n FROM events e ${where}`).get(...params) as Row).n;
    const rows = (db.prepare(`SELECT e.*,o.name FROM events e LEFT JOIN orders o ON o.id=e.order_id ${where} ORDER BY e.id DESC LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size) as Row[]).map(e => ({ id: e.id, orderId: e.order_id, orderName: e.name, actorName: e.actor_name, actorId: e.actor_id, type: e.type, detail: JSON.parse(e.detail), createdAt: e.created_at }));
    res.json({ rows, total, page, pageSize: size });
  });
  api.get('/settings', (req, res) => { requireUser(req, 'settings'); res.json({ ...getSettings(), syncing: isSyncing(), apiVersion: config.shopifyVersion, publicUrl: config.publicUrl, backupRetention: config.backupRetention }); });
  api.patch('/settings', (req, res) => {
    const auth = requireUser(req, 'settings');
    const input = z.object({ timezone: z.string().max(80).optional(), autoSync: z.boolean().optional(), syncMinutes: z.number().int().min(2).max(60).optional(), dispatchToShopify: z.boolean().optional(), notifyCustomer: z.boolean().optional(), allowCOD: z.boolean().optional(), couriers: z.array(z.string().min(1).max(60)).min(1).max(30).optional() }).strict().parse(req.body);
    res.json(updateOperational(input, auth.user));
  });
  api.post('/shopify/connect', asyncRoute(async (req, res) => {
    const auth = requireUser(req, 'settings'); assert(!isSyncing(), 409, 'Wait for the current import to finish.');
    const input = z.object({ domain: z.string().trim().toLowerCase().max(150), token: z.string().max(500).optional(), secret: z.string().max(500).optional() }).parse(req.body);
    const previous = getCredentials(); const token = input.token || (previous?.domain === input.domain ? previous.token : '');
    assert(token, 400, 'Enter your Admin API access token.');
    const shop = await testShopify(input.domain, token);
    saveCredentials({ domain: input.domain, token, secret: input.secret || (previous?.domain === input.domain ? previous.secret : ''), shopName: shop.name, webhookIds: previous?.domain === input.domain ? previous.webhookIds : [] });
    recordEvent(null, auth.user, 'SHOPIFY_CONNECTED', { domain: input.domain, shopName: shop.name }); res.json(getSettings());
  }));
  api.post('/shopify/webhooks', asyncRoute(async (req, res) => { const auth = requireUser(req, 'settings'); await registerWebhooks(auth.user); res.json(getSettings()); }));
  api.post('/shopify/sync', asyncRoute(async (req, res) => {
    const auth = requireUser(req, 'import'); const input = z.object({ mode: z.enum(['incremental', 'rescan']).default('incremental') }).parse(req.body || {});
    assert(!isSyncing(), 409, 'An import is already running.');
    void syncOrders(auth.user, input.mode).then(broadcast).catch(() => broadcast()); res.status(202).json({ started: true });
  }));
  api.get('/users', (req, res) => { requireUser(req, 'staff'); res.json((db.prepare('SELECT * FROM users ORDER BY created_at').all() as Row[]).map(publicUser)); });
  api.post('/users', asyncRoute(async (req, res) => {
    const auth = requireUser(req, 'staff'); const input = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema, role: roleSchema }).parse(req.body);
    const hash = await hashPassword(input.password); const id = crypto.randomUUID();
    try { db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)').run(id, input.name, input.email, hash, input.role, now()); }
    catch (e: any) { if (e.code?.startsWith('SQLITE_CONSTRAINT')) throw new AppError(409, 'An account with this email already exists.'); throw e; }
    recordEvent(null, auth.user, 'USER_CREATED', { userId: id, name: input.name, role: input.role }); res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id) as Row));
  }));
  api.patch('/users/:id', (req, res) => {
    const auth = requireUser(req, 'staff'); const input = z.object({ name: nameSchema.optional(), role: roleSchema.optional(), active: z.boolean().optional() }).parse(req.body);
    db.transaction(() => {
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(idParam(req)) as Row; assert(user, 404, 'Staff account not found.');
      assert(user.id !== auth.user.id || (input.active !== false && (!input.role || input.role === 'owner')), 400, 'You cannot disable or demote your own owner account.');
      if (user.role === 'owner' && user.active && (input.active === false || (input.role && input.role !== 'owner'))) assert((db.prepare("SELECT count(*) AS n FROM users WHERE role='owner' AND active=1").get() as Row).n > 1, 409, 'Keep at least one active owner.');
      db.prepare('UPDATE users SET name=?,role=?,active=? WHERE id=?').run(input.name ?? user.name, input.role ?? user.role, input.active === undefined ? user.active : Number(input.active), user.id);
      if (input.active === false || (input.role && input.role !== user.role)) db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      recordEvent(null, auth.user, 'USER_UPDATED', { userId: user.id, before: { name: user.name, role: user.role, active: !!user.active }, after: input });
    })(); res.json({ ok: true });
  });
  api.post('/users/:id/password', asyncRoute(async (req, res) => {
    const auth = requireUser(req, 'staff'); const input = z.object({ password: passwordSchema }).parse(req.body);
    assert(db.prepare('SELECT id FROM users WHERE id=?').get(idParam(req)), 404, 'Staff account not found.');
    const hash = await hashPassword(input.password);
    db.transaction(() => { db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, idParam(req)); db.prepare('DELETE FROM sessions WHERE user_id=?').run(idParam(req)); recordEvent(null, auth.user, 'PASSWORD_RESET', { userId: idParam(req) }); })(); res.json({ ok: true });
  }));
  api.post('/account/password', asyncRoute(async (req, res) => {
    const auth = resLocal(req)!; const input = z.object({ currentPassword: z.string().max(128), password: passwordSchema }).parse(req.body);
    const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(auth.user.id) as Row;
    assert(await verifyPassword(input.currentPassword, row.password_hash), 400, 'Current password is incorrect.');
    const hash = await hashPassword(input.password);
    db.transaction(() => { db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, auth.user.id); db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(auth.user.id, auth.tokenHash); recordEvent(null, auth.user, 'PASSWORD_CHANGED'); })(); res.json({ ok: true });
  }));
  api.get('/backups', (req, res) => { requireUser(req, 'settings'); res.json(db.prepare('SELECT * FROM backups ORDER BY created_at DESC').all()); });
  api.post('/backups', asyncRoute(async (req, res) => { const auth = requireUser(req, 'settings'); const backup = await createBackup(`Manual backup by ${auth.user.name}`); res.status(201).json(backup); }));
  api.get('/backups/:id/download', (req, res) => {
    requireUser(req, 'settings'); const backup = db.prepare('SELECT * FROM backups WHERE id=?').get(idParam(req)) as Row; assert(backup, 404, 'Backup not found.');
    const file = path.join(config.dataDir, 'backups', path.basename(backup.filename)); assert(fs.existsSync(file), 404, 'Backup file is no longer on disk.');
    recordEvent(null, resLocal(req)!.user, 'BACKUP_DOWNLOADED', { filename: backup.filename }); res.download(file, backup.filename, { dotfiles: 'allow' });
  });
  api.get('/reports/:type', rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }), asyncRoute(async (req, res) => {
    const auth = requireUser(req, 'reports'); const type = String(req.params.type); assert(['orders', 'pending', 'activity', 'staff'].includes(type), 400, 'Unknown report type.');
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    workbook.creator = 'Mettwear Operations'; workbook.created = new Date();
    const sheet = (name: string, columns: { header: string; key: string; width: number }[]) => { const s = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] }); s.columns = columns; s.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; s.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153C35' } }; s.getRow(1).commit(); return s; };
    const col = (header: string, key = header.toLowerCase().replace(/[^a-z]+/g, '_'), width = 24) => ({ header, key, width });
    const safe = (value: unknown) => typeof value === 'string' && /^[=+@\-\t\r]/.test(value) ? `'${value}` : value ?? '';
    const write = (worksheet: ExcelJS.Worksheet, values: Record<string, unknown>) => {
      const row: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(values)) { row[key] = safe(value); row[key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)] = safe(value); }
      worksheet.addRow(row).commit();
    };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="mettwear-${type}-${localDay()}.xlsx"`);
    recordEvent(null, auth.user, 'REPORT_EXPORTED', { type, filters: filters(req) });
    if (type === 'orders' || type === 'pending') {
      const orders = sheet(type === 'pending' ? 'Outstanding orders' : 'Orders', [col('Order'), col('Shopify order ID', 'id', 38), col('Created at'), col('Customer', 'customerName'), col('City'), col('Status'), col('Courier'), col('CN'), col('Due date'), col('Packed at'), col('Packed by'), col('Dispatched at'), col('Dispatched by'), col('Shopify sync', 'shopifySyncStatus'), col('Payment', 'financialStatus'), col('Shopify fulfillment', 'fulfillmentStatus'), col('Review reason', 'reviewReason', 50)]);
      const items = sheet('Packing checklist', [col('Order'), col('Product', 'title', 45), col('Variant'), col('Size'), col('Colour', 'color'), col('SKU'), col('Barcode'), col('Ordered quantity', 'quantity'), col('Active quantity', 'currentQuantity'), col('Verified quantity', 'verifiedQuantity'), col('Attributes checked', 'attributesVerified'), col('Verified by', 'verifiedBy'), col('Verified at', 'verifiedAt')]);
      const f = { ...filters(req), ...(type === 'pending' ? { status: 'pending' } : {}) };
      let page = 1; let total = Infinity;
      while ((page - 1) * 100 < total) { const result = queryOrderRows({ ...f, page, pageSize: 100 }, auth.user); total = result.total; for (const o of result.rows) { write(orders, { ...o, order: o.name, items: undefined, customer: undefined }); for (const item of o.items) write(items, { order: o.name, ...item }); } page++; }
      orders.commit(); items.commit();
      if (type === 'pending') {
        const daily = sheet('Daily pending register', [col('Day'), col('Order'), col('Status at check', 'status'), col('Checked at'), col('Checked by'), col('Note', 'note', 55), col('Resolved at')]);
        for (const row of db.prepare('SELECT p.*,o.name,u.name AS checked_by FROM daily_pending p JOIN orders o ON o.id=p.order_id LEFT JOIN users u ON u.id=p.checked_by ORDER BY day DESC').iterate() as Iterable<Row>) write(daily, { ...row, checked_by: row.checked_by });
        daily.commit();
      }
    }
    if (type === 'orders' || type === 'activity') {
      const history = sheet('Complete activity history', [col('Event ID', 'id'), col('Time', 'createdAt', 30), col('Staff member', 'actorName'), col('Action', 'type'), col('Order', 'orderName'), col('Details', 'detail', 90)]);
      const { where, params } = eventFilter(req, auth.user);
      const sql = `SELECT e.*,o.name FROM events e LEFT JOIN orders o ON o.id=e.order_id ${where} ORDER BY e.id`;
      for (const row of db.prepare(sql).iterate(...params) as Iterable<Row>) write(history, { ...row, orderName: row.name, detail: JSON.stringify(JSON.parse(row.detail)) });
      history.commit();
    }
    if (type === 'staff' || type === 'activity') {
      const staff = sheet('Staff performance', [col('Staff member', 'name'), col('Role'), col('Packed total', 'packed'), col('Dispatched total', 'dispatched'), col('Packed in selected period', 'packedPeriod'), col('Dispatched in selected period', 'dispatchedPeriod')]);
      const f = filters(req); const period: string[] = []; const params: any[] = [];
      if (/^\d{4}-\d{2}-\d{2}$/.test(f.from || '')) { period.push('created_at>=?'); params.push(dayBounds(f.from!).start); }
      if (/^\d{4}-\d{2}-\d{2}$/.test(f.to || '')) { period.push('created_at<?'); params.push(dayBounds(f.to!).end); }
      const where = period.length ? `AND ${period.join(' AND ')}` : '';
      for (const user of db.prepare('SELECT * FROM users ORDER BY name').iterate() as Iterable<Row>) {
        const count = (event: string, range = '') => (db.prepare(`SELECT count(*) AS n FROM events WHERE actor_id=? AND type=? ${range}`).get(user.id, event, ...(range ? params : [])) as Row).n;
        write(staff, { name: user.name, role: user.role, packed: count('ORDER_PACKED'), dispatched: count('ORDER_DISPATCHED'), packedPeriod: count('ORDER_PACKED', where), dispatchedPeriod: count('ORDER_DISPATCHED', where) });
      }
      staff.commit();
    }
    await workbook.commit();
  }));
  api.use((_req, _res, next) => next(new AppError(404, 'API endpoint not found.')));
  api.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), code: 'VALIDATION' });
    if (error instanceof AppError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON request.' });
    if (error.code?.startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'This record conflicts with an existing record. Reload and try again.', code: 'CONFLICT' });
    console.error('API error:', error instanceof Error ? error.message.replace(/shpat_[A-Za-z0-9_]+/g, '[redacted]') : 'Unknown error');
    res.status(500).json({ error: 'The server could not complete this request. Your existing records are safe; try again.' });
  });
  return api;
}
export function startSchedulers() {
  ensureRollover();
  db.prepare("UPDATE jobs SET status='queued' WHERE status='running'").run();
  const jobs = setInterval(() => { void processJobs().then(broadcast); }, 10000);
  const maintenance = setInterval(() => { ensureRollover(); db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now()); }, 30000);
  let lastSync = 0, lastBackupDay = '';
  const automatic = setInterval(async () => {
    const settings = getSettings();
    if (settings.connected && settings.autoSync && !isSyncing() && Date.now() - lastSync >= settings.syncMinutes * 60000) {
      lastSync = Date.now(); try { await syncOrders(null); broadcast(); } catch { broadcast(); }
    }
    const day = localDay();
    if (lastBackupDay !== day) { lastBackupDay = day; try { await createBackup(); broadcast(); } catch (error) { console.error('Backup failed:', error instanceof Error ? error.message : 'Unknown error'); recordEvent(null, null, 'BACKUP_FAILED', { message: error instanceof Error ? error.message : 'Unknown error' }); } }
  }, 30000);
  void processJobs().then(broadcast);
  return () => { clearInterval(jobs); clearInterval(maintenance); clearInterval(automatic); clearTimeout(broadcastTimer); for (const [res] of clients) res.end(); clients.clear(); };
}
export { receiveWebhook };
