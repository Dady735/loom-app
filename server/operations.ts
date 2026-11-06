import crypto from 'node:crypto';
import { db, getSetting, setSetting, recordEvent } from './db.js';
import { AppError, assert, decrypt, encrypt, normalizeCN, now } from './security.js';
import type { Dashboard, Order, OrderEvent, OrderItem, Permission, Role, Settings, User } from '../shared/types.js';

export type Row = Record<string, any>;
export interface Credentials { domain: string; token: string; secret: string; shopName: string; webhookIds: string[] }
const operationalDefaults = {
  timezone: 'Asia/Karachi', cutoff: '23:59', autoSync: true, syncMinutes: 5,
  dispatchToShopify: true, notifyCustomer: false, allowCOD: false,
  couriers: ['Leopards', 'TCS', 'M&P', 'Pakistan Post', 'Trax', 'PostEx', 'Other'],
};
export function getOperational() { return { ...operationalDefaults, ...getSetting('operational', operationalDefaults) }; }
export function getCredentials(): Credentials | null {
  const stored = getSetting<any>('shopify', null);
  if (!stored) return null;
  return { domain: stored.domain, token: decrypt(stored.token), secret: stored.secret ? decrypt(stored.secret) : '', shopName: stored.shopName || '', webhookIds: stored.webhookIds || [] };
}
export function saveCredentials(value: Credentials) {
  setSetting('shopify', { ...value, token: encrypt(value.token), secret: value.secret ? encrypt(value.secret) : '' });
}
export function getSettings(): Settings {
  const credentials = getCredentials();
  return { ...getOperational(), shopDomain: credentials?.domain || '', shopName: credentials?.shopName || '', connected: !!credentials,
    lastSyncAt: getSetting('lastSyncAt', null), lastSyncError: getSetting('lastSyncError', null),
    webhookEnabled: !!credentials?.webhookIds?.length, lastWebhookAt: getSetting('lastWebhookAt', null), lastBackupAt: getSetting('lastBackupAt', null) };
}
export function updateOperational(input: Partial<typeof operationalDefaults>, actor: User) {
  const current = getOperational();
  const next = { ...current, ...input };
  try { new Intl.DateTimeFormat('en', { timeZone: next.timezone }); } catch { throw new AppError(400, 'Choose a valid IANA timezone.'); }
  assert(/^([01]\d|2[0-3]):[0-5]\d$/.test(next.cutoff), 400, 'Cutoff must be a valid time, HH:MM.');
  assert(Number.isInteger(next.syncMinutes) && next.syncMinutes >= 2 && next.syncMinutes <= 60, 400, 'Sync interval must be 2–60 minutes.');
  assert(Array.isArray(next.couriers) && next.couriers.length > 0 && next.couriers.length <= 30 && next.couriers.every(x => typeof x === 'string' && x.trim().length > 0 && x.length <= 60), 400, 'Provide 1–30 courier names.');
  next.couriers = [...new Set(next.couriers.map(x => x.trim()))];
  for (const field of ['autoSync', 'dispatchToShopify', 'notifyCustomer', 'allowCOD'] as const) assert(typeof next[field] === 'boolean', 400, 'Invalid setting.');
  db.transaction(() => { setSetting('operational', next); recordEvent(null, actor, 'SETTINGS_UPDATED', { before: current, after: next }); })();
  return getSettings();
}
export const permissions: Record<Role, Permission[]> = {
  owner: ['import', 'assign', 'verify', 'pack', 'dispatch', 'check', 'reconcile', 'reports', 'staff', 'settings', 'activity'],
  supervisor: ['import', 'assign', 'verify', 'pack', 'dispatch', 'check', 'reports', 'activity'],
  staff: ['verify', 'pack', 'dispatch', 'check'],
};
export const can = (user: User, permission: Permission) => permissions[user.role].includes(permission);
export function publicUser(row: Row): User {
  return { id: row.id, name: row.name, email: row.email, role: row.role, active: !!row.active, createdAt: row.created_at, lastLoginAt: row.last_login_at };
}
export function localDay(value: string | Date = new Date(), timezone = getOperational().timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-');
}
export function addDays(day: string, amount: number) { return new Date(new Date(`${day}T12:00:00Z`).getTime() + amount * 86400000).toISOString().slice(0, 10); }
export function dayBounds(day: string, timezone = getOperational().timezone) {
  const offset = (date: Date) => {
    const zone = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }).formatToParts(date).find(p => p.type === 'timeZoneName')!.value;
    const match = zone.match(/GMT(?:([+-])(\d{2}):(\d{2}))?$/);
    return match?.[1] ? (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3])) * 60000 : 0;
  };
  const nominal = new Date(`${day}T00:00:00Z`).getTime();
  const start = new Date(nominal - offset(new Date(nominal)));
  const end = new Date(nominal + 86400000 - offset(new Date(nominal + 86400000)));
  return { start: start.toISOString(), end: end.toISOString() };
}
export function mapEvent(row: Row): OrderEvent {
  return { id: row.id, orderId: row.order_id, orderName: row.name, actorName: row.actor_name, actorId: row.actor_id, type: row.type, detail: JSON.parse(row.detail), createdAt: row.created_at };
}
export function mapOrder(row: Row, user: User, withItems = true): Order {
  const customer = can(user, 'reports') && row.customer_secure ? JSON.parse(decrypt(row.customer_secure)) : {};
  const order: Order = {
    id: row.id, name: row.name, numericId: row.numeric_id, createdAt: row.created_at, updatedAt: row.updated_at, importedAt: row.imported_at,
    customerName: row.customer_name, city: row.city, financialStatus: row.financial_status, fulfillmentStatus: row.fulfillment_status,
    cancelledAt: row.cancelled_at, tags: JSON.parse(row.tags), note: row.note, total: row.total, currency: row.currency, gateways: JSON.parse(row.gateways),
    status: row.status, cn: row.cn, courier: row.courier, trackingUrl: row.tracking_url, cnConflict: row.cn_conflict, version: row.version,
    dueDate: row.due_date, firstQueuedAt: row.first_queued_at, packedAt: row.packed_at, packedBy: row.packed_by_name || row.packed_by,
    dispatchedAt: row.dispatched_at, dispatchedBy: row.dispatched_by_name || row.dispatched_by, reviewReason: row.review_reason,
    shopifySyncStatus: row.shopify_sync_status, shopifySyncError: row.shopify_sync_error, items: [],
    pendingSince: row.pending_since, checkedAt: row.checked_at, checkedBy: row.checked_by_name || row.checked_by, checkNote: row.check_note,
  };
  if (can(user, 'reports')) order.customer = customer;
  if (withItems) order.items = (db.prepare('SELECT i.*, u.name AS verifier_name FROM order_items i LEFT JOIN users u ON u.id=i.verified_by WHERE order_id=? ORDER BY i.rowid').all(row.id) as Row[]).map(i => ({
    id: i.id, title: i.title, variant: i.variant, size: i.size, color: i.color, sku: i.sku, barcode: i.barcode,
    quantity: i.quantity, currentQuantity: i.current_quantity, requiresShipping: !!i.requires_shipping,
    verifiedQuantity: i.verified_quantity, attributesVerified: !!i.attributes_verified, verifiedBy: i.verifier_name || i.verified_by, verifiedAt: i.verified_at,
  }));
  return order;
}
const orderSelect = `SELECT o.*, pu.name AS packed_by_name, du.name AS dispatched_by_name,
  (SELECT min(day) FROM daily_pending p WHERE p.order_id=o.id) AS pending_since,
  (SELECT checked_at FROM daily_pending p WHERE p.order_id=o.id ORDER BY day DESC LIMIT 1) AS checked_at,
  (SELECT u.name FROM daily_pending p LEFT JOIN users u ON u.id=p.checked_by WHERE p.order_id=o.id ORDER BY day DESC LIMIT 1) AS checked_by_name,
  (SELECT note FROM daily_pending p WHERE p.order_id=o.id ORDER BY day DESC LIMIT 1) AS check_note
  FROM orders o LEFT JOIN users pu ON pu.id=o.packed_by LEFT JOIN users du ON du.id=o.dispatched_by`;
export function rawOrder(id: string) { return db.prepare('SELECT * FROM orders WHERE id=?').get(id) as Row | undefined; }
export function getOrder(id: string, user: User) {
  const row = db.prepare(`${orderSelect} WHERE o.id=?`).get(id) as Row | undefined;
  assert(row, 404, 'Order not found. Import it from Shopify first.');
  return { order: mapOrder(row, user), events: (db.prepare('SELECT e.*,o.name FROM events e LEFT JOIN orders o ON o.id=e.order_id WHERE e.order_id=? ORDER BY e.id DESC').all(id) as Row[]).map(mapEvent) };
}
export function lookupOrder(code: string, user: User) {
  const cn = normalizeCN(code);
  const name = code.trim().replace(/^#/, '');
  const row = db.prepare(`${orderSelect} WHERE o.cn_key=? OR o.name=? OR o.name=? OR o.numeric_id=? LIMIT 2`).all(cn, name, `#${name}`, name) as Row[];
  assert(row.length === 1, row.length ? 409 : 404, row.length ? 'More than one order matches this code.' : 'No imported order matches this parcel code. Check the CN or ask the owner to import Shopify orders.');
  recordEvent(row[0].id, user, 'PARCEL_SCANNED', { code: cn });
  return mapOrder(row[0], user);
}
export interface OrderFilters { q?: string; status?: string; courier?: string; from?: string; to?: string; pendingDay?: string; page?: number; pageSize?: number }
function filterSQL(filters: OrderFilters, user: User) {
  const clauses: string[] = []; const params: any[] = [];
  if (filters.q) {
    const q = `%${filters.q.trim().slice(0, 120)}%`;
    clauses.push('(o.name LIKE ? OR o.cn LIKE ? OR o.customer_name LIKE ? OR EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=o.id AND (i.sku LIKE ? OR i.title LIKE ?)))'); params.push(q, q, q, q, q);
  }
  if (filters.status === 'pending') clauses.push("o.status!='dispatched'");
  else if (filters.status === 'unassigned') clauses.push("o.cn='' AND o.status!='dispatched'");
  else if (['ready', 'packed', 'dispatched', 'review'].includes(filters.status || '')) { clauses.push('o.status=?'); params.push(filters.status); }
  if (filters.courier) { clauses.push('o.courier=?'); params.push(filters.courier); }
  const tz = getOperational().timezone;
  if (filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from)) { clauses.push('o.created_at>=?'); params.push(dayBounds(filters.from, tz).start); }
  if (filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)) { clauses.push('o.created_at<?'); params.push(dayBounds(filters.to, tz).end); }
  if (filters.pendingDay && /^\d{4}-\d{2}-\d{2}$/.test(filters.pendingDay)) {
    clauses.push('EXISTS(SELECT 1 FROM daily_pending p WHERE p.order_id=o.id AND p.day=?)'); params.push(filters.pendingDay);
    if (filters.status === 'pending') clauses.push("o.status!='dispatched'");
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}
export function queryOrderRows(filters: OrderFilters, user: User, paginate = true) {
  const { where, params } = filterSQL(filters, user);
  const total = (db.prepare(`SELECT count(*) AS n FROM orders o ${where}`).get(...params) as Row).n;
  const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize || 25)));
  const page = Math.max(1, Number(filters.page || 1));
  const sql = `${orderSelect} ${where} ORDER BY CASE o.status WHEN 'review' THEN 0 WHEN 'ready' THEN 1 WHEN 'packed' THEN 2 ELSE 3 END, o.created_at DESC ${paginate ? 'LIMIT ? OFFSET ?' : ''}`;
  const rows = db.prepare(sql).all(...params, ...(paginate ? [pageSize, (page - 1) * pageSize] : [])) as Row[];
  return { rows: rows.map(r => mapOrder(r, user)), total, page, pageSize };
}
export function rollPending(today = localDay()) {
  const earliest = db.prepare("SELECT min(due_date) AS day FROM orders WHERE status!='dispatched'").get() as Row;
  if (!earliest?.day) return;
  const insert = db.prepare("INSERT OR IGNORE INTO daily_pending(day,order_id,status,created_at) SELECT ?,o.id,o.status,? FROM orders o WHERE o.status!='dispatched' AND o.due_date<=?");
  db.transaction(() => {
    for (let day = earliest.day; day < today; day = addDays(day, 1)) insert.run(day, now(), day);
    recordEvent(null, null, 'DAILY_ROLLOVER', { through: addDays(today, -1), timezone: getOperational().timezone });
  })();
}
export function requireVersion(order: Row, version: number) {
  assert(Number.isInteger(version), 400, 'An order version is required.');
  assert(order.version === version, 409, 'This order changed on another device. Reload it before continuing.', 'STALE_VERSION');
}
export function paymentIssue(order: Row) {
  if (order.cancelled_at) return 'This order was cancelled in Shopify. Do not pack it.';
  const financial = order.financial_status;
  const cod = getOperational().allowCOD && JSON.parse(order.gateways).some((g: string) => /cash on delivery|\bcod\b/i.test(g));
  if (!['PAID', 'AUTHORIZED'].includes(financial) && !cod) return `Payment is ${financial || 'unknown'}. Resolve payment in Shopify before packing.`;
  return '';
}
export function verifiedItems(orderId: string) { return (db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId) as Row[]).filter(i => i.requires_shipping && i.current_quantity > 0); }
export function allVerified(items: Row[]) { return items.length > 0 && items.every(i => i.attributes_verified && i.verified_quantity === i.current_quantity); }
export function assignCN(id: string, input: { cn: string; courier: string; trackingUrl?: string; version: number }, actor: User) {
  assert(can(actor, 'assign'), 403, 'Only the owner or a supervisor can assign courier CN numbers.');
  const cn = normalizeCN(input.cn);
  assert(/^[A-Z0-9][A-Z0-9-]{3,79}$/.test(cn), 400, 'Enter a valid CN (4–80 letters, digits or hyphens). Leading zeros are preserved.');
  assert(getOperational().couriers.includes(input.courier), 400, 'Choose a configured courier.');
  if (input.trackingUrl) { try { assert(new URL(input.trackingUrl).protocol === 'https:', 400, 'Tracking URLs must use HTTPS.'); } catch { throw new AppError(400, 'Enter a valid HTTPS tracking URL.'); } }
  db.transaction(() => {
    const order = rawOrder(id); assert(order, 404, 'Order not found.'); requireVersion(order, input.version);
    assert(order.status !== 'dispatched', 409, 'Dispatched orders keep their original CN for auditability.');
    const duplicate = db.prepare('SELECT name FROM orders WHERE cn_key=? AND id!=?').get(cn, id) as Row;
    assert(!duplicate, 409, `Duplicate CN: already assigned to order ${duplicate?.name || 'another order'}.`, 'DUPLICATE_CN');
    db.prepare("UPDATE orders SET cn=?,cn_key=?,courier=?,tracking_url=?,cn_conflict='',version=version+1 WHERE id=?").run(input.cn.trim(), cn, input.courier, input.trackingUrl || '', id);
    recordEvent(id, actor, 'CN_ASSIGNED', { cn: input.cn.trim(), courier: input.courier, previousCN: order.cn });
  })();
  return getOrder(id, actor).order;
}
export function saveVerification(id: string, input: { version: number; items: { id: string; quantity: number; checked: boolean }[] }, actor: User) {
  db.transaction(() => {
    const order = rawOrder(id); assert(order, 404, 'Order not found.'); requireVersion(order, input.version);
    assert(order.status === 'ready', 409, 'Only an unpacked, active order can be verified.');
    const issue = paymentIssue(order); assert(!issue, 409, issue);
    const items = verifiedItems(id);
    assert(input.items.length === items.length && new Set(input.items.map(i => i.id)).size === items.length, 400, 'Verify every active product line exactly once.');
    for (const checked of input.items) {
      const item = items.find(i => i.id === checked.id);
      assert(item && Number.isInteger(checked.quantity) && checked.quantity >= 0 && checked.quantity <= item.current_quantity && typeof checked.checked === 'boolean', 400, 'Checked quantities must match the Shopify line quantities and cannot exceed them.');
      assert(!checked.checked || checked.quantity === item.current_quantity, 400, 'Confirm the full quantity before checking a product line.');
      db.prepare('UPDATE order_items SET verified_quantity=?,attributes_verified=?,verified_by=?,verified_at=? WHERE id=? AND order_id=?')
        .run(checked.quantity, checked.checked ? 1 : 0, actor.id, now(), checked.id, id);
    }
    db.prepare('UPDATE orders SET version=version+1 WHERE id=?').run(id);
    recordEvent(id, actor, 'ITEMS_VERIFIED', { lines: items.length, units: input.items.reduce((s, i) => s + i.quantity, 0), complete: input.items.every(i => i.checked), items: input.items });
  })();
  return getOrder(id, actor).order;
}
export function packOrder(id: string, version: number, actor: User) {
  db.transaction(() => {
    const order = rawOrder(id); assert(order, 404, 'Order not found.'); requireVersion(order, version);
    assert(order.status === 'ready', 409, 'This order is already packed, dispatched, or needs reconciliation.');
    assert(!paymentIssue(order), 409, paymentIssue(order));
    assert(order.cn && order.courier && !order.cn_conflict, 409, 'The owner must assign a courier and a unique CN before packing.');
    assert(allVerified(verifiedItems(id)), 409, 'Verify every product name, size, colour and exact quantity before marking Packed.');
    const at = now();
    const result = db.prepare("UPDATE orders SET status='packed',packed_at=?,packed_by=?,version=version+1 WHERE id=? AND version=? AND status='ready'").run(at, actor.id, id, version);
    assert(result.changes === 1, 409, 'Order changed. Reload before packing.');
    recordEvent(id, actor, 'ORDER_PACKED', { cn: order.cn, units: verifiedItems(id).reduce((s, i) => s + i.current_quantity, 0) }, at);
  })();
  return getOrder(id, actor).order;
}
function resolvePending(orderId: string, at: string) { db.prepare('UPDATE daily_pending SET resolved_at=? WHERE order_id=? AND resolved_at IS NULL').run(at, orderId); }
export function dispatchOrder(id: string, input: { version: number; handoverConfirmed: boolean }, actor: User) {
  assert(input.handoverConfirmed === true, 400, 'Confirm the courier has physically received the parcel.');
  db.transaction(() => {
    const order = rawOrder(id); assert(order, 404, 'Order not found.'); requireVersion(order, input.version);
    assert(order.status === 'packed', 409, 'Only a verified, Packed order can be dispatched.');
    assert(!order.cancelled_at, 409, 'This order has been cancelled. Refresh Shopify before handover.');
    const at = now();
    const sync = getOperational().dispatchToShopify ? 'queued' : 'disabled';
    const result = db.prepare("UPDATE orders SET status='dispatched',dispatched_at=?,dispatched_by=?,shopify_sync_status=?,version=version+1 WHERE id=? AND version=? AND status='packed'").run(at, actor.id, sync, id, input.version);
    assert(result.changes === 1, 409, 'Order changed. Reload before dispatch.');
    resolvePending(id, at);
    recordEvent(id, actor, 'ORDER_DISPATCHED', { cn: order.cn, courier: order.courier, handoverConfirmed: true, units: verifiedItems(id).reduce((s, i) => s + i.current_quantity, 0) }, at);
    if (sync === 'queued') {
      const jobId = crypto.randomUUID();
      const payload = JSON.stringify(verifiedItems(id).map(i => ({ id: i.id, quantity: i.current_quantity })));
      db.prepare("INSERT INTO jobs(id,order_id,idempotency_key,payload,next_attempt_at,created_at,updated_at) VALUES (?,?,'mettwear-'||?,?,?,?,?)").run(jobId, id, jobId, payload, at, at, at);
      // A job is picked up by the server after the transaction commits.
    }
  })();
  return getOrder(id, actor).order;
}
export function checkPending(id: string, input: { note: string; stillOutstanding: boolean }, actor: User) {
  assert(input.stillOutstanding === true, 400, 'Confirm that the parcel is physically still in the warehouse.');
  assert(typeof input.note === 'string' && input.note.trim().length >= 3 && input.note.length <= 1000, 400, 'Add a short verification note (3–1,000 characters).');
  const at = now(); const day = localDay();
  db.transaction(() => {
    const order = rawOrder(id); assert(order, 404, 'Order not found.'); assert(order.status !== 'dispatched', 409, 'This order is already dispatched.');
    db.prepare('INSERT INTO daily_pending(day,order_id,status,created_at) VALUES (?,?,?,?) ON CONFLICT(day,order_id) DO NOTHING').run(day, id, order.status, at);
    db.prepare('UPDATE daily_pending SET checked_at=?,checked_by=?,note=? WHERE day=? AND order_id=?').run(at, actor.id, input.note.trim(), day, id);
    recordEvent(id, actor, 'PENDING_VERIFIED', { note: input.note.trim(), stillOutstanding: true, day }, at);
  })();
  return getOrder(id, actor).order;
}
export function resolveReview(id: string, input: { resolution: 'dispatched' | 'outstanding'; evidence: string; version: number }, actor: User) {
  assert(can(actor, 'reconcile'), 403, 'Only the owner can reconcile a Shopify discrepancy.');
  assert(input.evidence.trim().length >= 8 && input.evidence.length <= 1000, 400, 'Record the courier manifest or Shopify evidence (at least 8 characters).');
  db.transaction(() => {
    const order = rawOrder(id); assert(order, 404, 'Order not found.'); requireVersion(order, input.version);
    assert(order.status === 'review', 409, 'This order does not need reconciliation.');
    const at = now();
    if (input.resolution === 'dispatched') {
      assert(order.fulfillment_status === 'FULFILLED', 409, 'Shopify must show this order fulfilled. Refresh Shopify and investigate before confirming an external dispatch.');
      assert(order.cn && order.courier, 409, 'A courier CN is required for the handover record.');
      db.prepare("UPDATE orders SET status='dispatched',dispatched_at=?,dispatched_by=?,shopify_sync_status='external',review_reason='',version=version+1 WHERE id=?").run(at, actor.id, id);
      resolvePending(id, at);
      recordEvent(id, actor, 'ORDER_DISPATCHED', { cn: order.cn, courier: order.courier, reconciled: true, evidence: input.evidence.trim() }, at);
    } else recordEvent(id, actor, 'REVIEW_CHECKED', { stillOutstanding: true, evidence: input.evidence.trim(), shopifyStatus: order.fulfillment_status }, at);
    recordEvent(id, actor, 'RECONCILIATION_RECORDED', { resolution: input.resolution, evidence: input.evidence.trim() }, at);
  })();
  return getOrder(id, actor).order;
}

export interface ShopifyLine { id: string; title: string; quantity: number; currentQuantity: number; requiresShipping: boolean; sku?: string; variantTitle?: string; variant?: { barcode?: string; selectedOptions?: { name: string; value: string }[] }; customAttributes?: { key: string; value: string }[] }
export interface ShopifyOrder {
  id: string; name: string; legacyResourceId?: string; createdAt: string; updatedAt: string; displayFinancialStatus?: string; displayFulfillmentStatus?: string;
  cancelledAt?: string; tags?: string[]; note?: string; paymentGatewayNames?: string[]; totalPriceSet?: { shopMoney: { amount: string; currencyCode: string } };
  customer?: { firstName?: string; lastName?: string; displayName?: string }; email?: string; phone?: string;
  shippingAddress?: { name?: string; address1?: string; address2?: string; city?: string; province?: string; country?: string; zip?: string; phone?: string };
  lineItems: { nodes: ShopifyLine[] }; fulfillments?: { trackingInfo?: { number?: string; company?: string; url?: string }[] }[];
}
export function upsertShopifyOrder(source: ShopifyOrder, actor: { id: string; name: string } | null = null, sourceName = 'Shopify import') {
  assert(source.id?.startsWith('gid://shopify/Order/') && source.name && source.createdAt && source.updatedAt && Array.isArray(source.lineItems?.nodes), 502, 'Shopify returned an incomplete order; nothing was imported.');
  return db.transaction(() => {
    const existing = rawOrder(source.id);
    if (existing && existing.updated_at > source.updatedAt) return { created: false, skipped: true, id: source.id };
    const at = now(); const day = localDay(at);
    const address = source.shippingAddress || {};
    const name = address.name || source.customer?.displayName || [source.customer?.firstName, source.customer?.lastName].filter(Boolean).join(' ') || 'Customer';
    const customerSecure = encrypt(JSON.stringify({ email: source.email || '', phone: address.phone || source.phone || '', address: [address.address1, address.address2, address.city, address.province, address.zip, address.country].filter(Boolean).join(', ') }));
    const lines = source.lineItems.nodes;
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ lines, financial: source.displayFinancialStatus, fulfillment: source.displayFulfillmentStatus, cancelled: source.cancelledAt, customerSecure: [name, address, source.email], note: source.note })).digest('hex');
    const changed = !!existing && existing.source_fingerprint !== fingerprint;
    const tracking = source.fulfillments?.flatMap(f => f.trackingInfo || []).find(t => t.number) || (source as any)._tracking;
    let cn = existing?.cn || ''; let courier = existing?.courier || ''; let trackingUrl = existing?.tracking_url || ''; let conflict = existing?.cn_conflict || '';
    if (tracking?.number) {
      const key = normalizeCN(tracking.number);
      const duplicate = db.prepare('SELECT name FROM orders WHERE cn_key=? AND id!=?').get(key, source.id) as Row;
      if (duplicate) conflict = `Shopify tracking ${tracking.number} is already assigned to ${duplicate.name}.`;
      else if (!cn) { cn = tracking.number; courier = tracking.company || 'Other'; trackingUrl = tracking.url || ''; }
      else if (normalizeCN(cn) !== key) conflict = `Shopify tracking ${tracking.number} differs from assigned CN ${cn}.`;
    }
    const external = ['FULFILLED', 'PARTIALLY_FULFILLED'].includes(source.displayFulfillmentStatus || '');
    let status = existing?.status || 'ready';
    let reviewReason = existing?.review_reason || '';
    if (source.cancelledAt && status !== 'dispatched') { status = 'review'; reviewReason = 'Cancelled in Shopify. Do not pack this order.'; }
    else if (external && status !== 'dispatched') { status = 'review'; reviewReason = `${source.displayFulfillmentStatus === 'FULFILLED' ? 'Already fulfilled' : 'Partially fulfilled'} in Shopify. Refresh and reconcile the physical handover before continuing.`; }
    else if (conflict && status !== 'dispatched') { status = 'review'; reviewReason = conflict; }
    else if (status === 'review' && !source.cancelledAt && !external && !conflict) { status = 'ready'; reviewReason = ''; }
    if (changed && status === 'packed') status = 'ready';
    const dueDate = existing?.due_date || [day, localDay(source.createdAt)].sort().reverse()[0];
    const values = [source.name, String(source.legacyResourceId || source.id.split('/').pop()), source.createdAt, source.updatedAt, name, address.city || '', customerSecure,
      source.displayFinancialStatus || '', source.displayFulfillmentStatus || 'UNFULFILLED', source.cancelledAt || null, JSON.stringify(source.tags || []), source.note || '',
      source.totalPriceSet?.shopMoney.amount || '0', source.totalPriceSet?.shopMoney.currencyCode || '', JSON.stringify(source.paymentGatewayNames || []), status,
      cn, cn ? normalizeCN(cn) : null, courier, trackingUrl, conflict, dueDate, reviewReason, fingerprint];
    if (existing) {
      db.prepare(`UPDATE orders SET name=?,numeric_id=?,created_at=?,updated_at=?,customer_name=?,city=?,customer_secure=?,financial_status=?,fulfillment_status=?,cancelled_at=?,tags=?,note=?,total=?,currency=?,gateways=?,status=?,cn=?,cn_key=?,courier=?,tracking_url=?,cn_conflict=?,due_date=?,review_reason=?,source_fingerprint=?,version=version+1 WHERE id=?`).run(...values, source.id);
    } else {
      db.prepare(`INSERT INTO orders(name,numeric_id,created_at,updated_at,customer_name,city,customer_secure,financial_status,fulfillment_status,cancelled_at,tags,note,total,currency,gateways,status,cn,cn_key,courier,tracking_url,cn_conflict,due_date,review_reason,source_fingerprint,id,imported_at,first_queued_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values, source.id, at, at);
      recordEvent(source.id, actor, 'ORDER_IMPORTED', { source: sourceName, shopifyStatus: source.displayFulfillmentStatus }, at);
    }
    if (changed) {
      const previousItems = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(source.id);
      recordEvent(source.id, actor, 'ORDER_UPDATED', { source: sourceName, previousItems, shopifyStatus: source.displayFulfillmentStatus, verificationReset: status !== 'dispatched', afterDispatch: existing?.status === 'dispatched' }, at);
    }
    if (!existing || (changed && existing.status !== 'dispatched')) {
      db.prepare('DELETE FROM order_items WHERE order_id=?').run(source.id);
      const insert = db.prepare('INSERT INTO order_items(id,order_id,title,variant,size,color,sku,barcode,quantity,current_quantity,requires_shipping) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
      for (const line of lines) {
        const options = line.variant?.selectedOptions || [];
        const size = options.find(o => /size|سائز/i.test(o.name))?.value || '';
        const color = options.find(o => /colou?r|رنگ/i.test(o.name))?.value || '';
        insert.run(line.id, source.id, line.title, line.variantTitle && line.variantTitle !== 'Default Title' ? line.variantTitle : '', size, color, line.sku || '', line.variant?.barcode || '', line.quantity, line.currentQuantity, line.requiresShipping ? 1 : 0);
      }
    }
    if (cn && (!existing?.cn || existing.cn !== cn)) recordEvent(source.id, actor, 'CN_IMPORTED', { cn, courier, source: sourceName }, at);
    if (conflict && conflict !== existing?.cn_conflict) recordEvent(source.id, actor, 'CN_CONFLICT', { message: conflict }, at);
    return { created: !existing, skipped: false, id: source.id };
  })();
}
export function dashboard(user: User): Dashboard {
  const tz = getOperational().timezone; const today = localDay(new Date(), tz); const { start, end } = dayBounds(today, tz);
  const counts = db.prepare("SELECT count(*) AS total, sum(status='ready') AS ready, sum(status='packed') AS packed, sum(status='dispatched') AS dispatched, sum(status!='dispatched') AS pending, sum(status='review') AS review, sum(status!='dispatched' AND due_date<?) AS carried, sum(status!='dispatched' AND due_date=?) AS dueToday FROM orders").get(today, today) as Row;
  const eventCount = (type: string, from = start, to = end) => (db.prepare('SELECT count(*) AS n FROM events WHERE type=? AND created_at>=? AND created_at<?').get(type, from, to) as Row).n;
  const packedToday = eventCount('ORDER_PACKED'); const dispatchedToday = eventCount('ORDER_DISPATCHED'); const importedToday = eventCount('ORDER_IMPORTED');
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const day = addDays(today, -i); const bounds = dayBounds(day, tz);
    trend.push({ day, label: new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short' }), packed: eventCount('ORDER_PACKED', bounds.start, bounds.end), dispatched: eventCount('ORDER_DISPATCHED', bounds.start, bounds.end), imported: eventCount('ORDER_IMPORTED', bounds.start, bounds.end) });
  }
  const activityWhere = can(user, 'activity') ? '' : 'WHERE e.actor_id=?';
  const activityParams = can(user, 'activity') ? [] : [user.id];
  const activity = (db.prepare(`SELECT e.*,o.name FROM events e LEFT JOIN orders o ON o.id=e.order_id ${activityWhere} ORDER BY e.id DESC LIMIT 8`).all(...activityParams) as Row[]).map(mapEvent);
  const staff = (db.prepare(`SELECT u.id,u.name,u.role,
    (SELECT count(*) FROM events e WHERE e.actor_id=u.id AND e.type='ORDER_PACKED' AND e.created_at>=? AND e.created_at<?) AS packed,
    (SELECT count(*) FROM events e WHERE e.actor_id=u.id AND e.type='ORDER_DISPATCHED' AND e.created_at>=? AND e.created_at<?) AS dispatched,
    (SELECT max(created_at) FROM events e WHERE e.actor_id=u.id) AS lastActive
    FROM users u WHERE u.active=1 ${can(user, 'activity') ? '' : 'AND u.id=?'} ORDER BY dispatched DESC,packed DESC`).all(start, end, start, end, ...(can(user, 'activity') ? [] : [user.id])) as Row[]).map(s => ({ id: s.id, name: s.name, role: s.role, packed: s.packed, dispatched: s.dispatched, lastActive: s.lastActive }));
  const unitCount = (db.prepare("SELECT coalesce(sum(CAST(json_extract(detail,'$.units') AS INTEGER)),0) AS n FROM events WHERE type='ORDER_DISPATCHED' AND created_at>=? AND created_at<?").get(start, end) as Row).n;
  const settings = getSettings();
  return { total: counts.total || 0, ready: counts.ready || 0, packed: counts.packed || 0, dispatched: counts.dispatched || 0, pending: counts.pending || 0, review: counts.review || 0,
    packedToday, dispatchedToday, importedToday, pendingVerifiedToday: (db.prepare('SELECT count(*) AS n FROM daily_pending WHERE day=? AND checked_at IS NOT NULL').get(today) as Row).n,
    carriedForward: counts.carried || 0, dueToday: counts.dueToday || 0, dispatchRate: counts.pending + counts.dispatched ? Math.round(counts.dispatched / (counts.pending + counts.dispatched) * 100) : 0,
    unitsDispatchedToday: unitCount, trend, activity, staff, today, timezone: tz, lastSyncAt: settings.lastSyncAt, lastSyncError: settings.lastSyncError, connected: settings.connected,
    failedSyncs: (db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('failed','blocked')").get() as Row).n, backupAt: settings.lastBackupAt };
}
export function pendingHistory(page = 1, pageSize = 30, day = '') {
  const where = /^\d{4}-\d{2}-\d{2}$/.test(day) ? 'WHERE p.day=?' : '';
  const params = where ? [day] : [];
  const total = (db.prepare(`SELECT count(*) AS n FROM daily_pending p ${where}`).get(...params) as Row).n;
  return { rows: db.prepare(`SELECT p.*,o.name,u.name AS checked_by_name FROM daily_pending p JOIN orders o ON o.id=p.order_id LEFT JOIN users u ON u.id=p.checked_by ${where} ORDER BY p.day DESC,o.name LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize), total, page, pageSize };
}
