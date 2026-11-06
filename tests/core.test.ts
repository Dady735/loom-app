// These Shopify-shaped fixtures exist ONLY in this isolated test database.
// They are never imported by the application or used in the live preview/production.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const directory = path.resolve('.test-data', `core-${process.pid}`);
fs.mkdirSync(directory, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = directory;
process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.SETUP_TOKEN = 'isolated-test-setup-key-not-for-production';
const { db, recordEvent, createBackup } = await import('../server/db.js');
const ops = await import('../server/operations.js');
const security = await import('../server/security.js');
const { verifyWebhook } = security;
const makeUser = (role: 'owner' | 'supervisor' | 'staff', id = role): import('../shared/types.js').User => ({ id, name: `Test ${role}`, email: `${id}@example.test`, role, active: true, createdAt: new Date().toISOString(), lastLoginAt: null });
const owner = makeUser('owner'), staff = makeUser('staff'), supervisor = makeUser('supervisor');
for (const user of [owner, staff, supervisor]) db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)').run(user.id, user.name, user.email, 'test-only-not-a-login-hash', user.role, user.createdAt);
let sequence = 1001;
function source(overrides: Record<string, any> = {}) {
  const n = sequence++;
  return {
    id: `gid://shopify/Order/${n}`, name: `#TEST-${n}`, legacyResourceId: String(n), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', paymentGatewayNames: ['Shopify Payments'], tags: [], note: '',
    totalPriceSet: { shopMoney: { amount: '2500.00', currencyCode: 'PKR' } }, customer: { displayName: 'Test customer' },
    shippingAddress: { name: 'Test customer', address1: 'Private test address', city: 'Karachi', phone: '+920000000000' }, email: 'private@example.test',
    lineItems: { nodes: [{ id: `gid://shopify/LineItem/${n}`, title: 'Test garment', quantity: 2, currentQuantity: 2, requiresShipping: true, sku: `TEST-SKU-${n}`, variantTitle: 'M / Black', variant: { barcode: `TEST-BAR-${n}`, selectedOptions: [{ name: 'Size', value: 'M' }, { name: 'Color', value: 'Black' }] } }], pageInfo: { hasNextPage: false, endCursor: null } },
    fulfillments: [], ...overrides,
  };
}
function imported() { const s = source(); ops.upsertShopifyOrder(s, owner); return ops.getOrder(s.id, owner).order; }
function assign(order: import('../shared/types.js').Order, cn = `TEST-CN-${order.numericId}`) { return ops.assignCN(order.id, { version: order.version, cn, courier: 'TCS' }, owner); }
function verify(order: import('../shared/types.js').Order) { return ops.saveVerification(order.id, { version: order.version, items: order.items.filter(i => i.requiresShipping && i.currentQuantity > 0).map(i => ({ id: i.id, quantity: i.currentQuantity, checked: true })) }, staff); }
after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('a new workspace contains no orders or invented performance', () => {
  const d = ops.dashboard(owner); assert.equal(d.total, 0); assert.equal(d.dispatched, 0); assert.equal(d.pending, 0); assert.ok(d.trend.every(x => x.packed === 0 && x.dispatched === 0));
});
test('password hashing and authenticated encryption round trip', async () => {
  const hash = await security.hashPassword('a-strong-test-password');
  assert.ok(!hash.includes('a-strong-test-password')); assert.equal(await security.verifyPassword('a-strong-test-password', hash), true); assert.equal(await security.verifyPassword('wrong', hash), false);
  const encrypted = security.encrypt('secret-token'); assert.ok(!encrypted.includes('secret-token')); assert.equal(security.decrypt(encrypted), 'secret-token');
  const parts = encrypted.split(':'); parts[2] = Buffer.from(Buffer.from(parts[2], 'base64').map((v,i) => i === 0 ? v ^ 1 : v)).toString('base64');
  assert.throws(() => security.decrypt(parts.join(':')));
});
test('normalization preserves leading zeros and webhook HMAC rejects tampering', () => {
  assert.equal(security.normalizeCN(' 000abc 123 '), '000ABC123');
  const raw = Buffer.from('{"id":123}'); const secret = 'test-secret'; const signature = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  assert.equal(verifyWebhook(raw, signature, secret), true); assert.equal(verifyWebhook(Buffer.from('{"id":124}'), signature, secret), false); assert.equal(verifyWebhook(raw, undefined, secret), false);
});
test('Shopify import stores real source fields and encrypts customer details', () => {
  const order = imported(); assert.equal(order.items[0].size, 'M'); assert.equal(order.items[0].color, 'Black'); assert.equal(order.items[0].quantity, 2);
  assert.equal(order.customer?.address.includes('Private test address'), true);
  const raw = ops.rawOrder(order.id)!; assert.ok(!raw.customer_secure.includes('Private test address')); assert.ok(!raw.customer_secure.includes('private@example.test'));
  const limited = ops.getOrder(order.id, staff).order; assert.equal(limited.customer, undefined); assert.equal(limited.items[0].title, 'Test garment');
});
test('CN uniqueness is atomic, case-insensitive and retains historical numbers', () => {
  const a = assign(imported(), '000TEST-1234'); const b = imported();
  assert.throws(() => ops.assignCN(b.id, { cn: '000test-1234', courier: 'TCS', version: b.version }, owner), (e: any) => e.code === 'DUPLICATE_CN');
  assert.equal(a.cn, '000TEST-1234'); assert.throws(() => ops.assignCN(b.id, { cn: 'TEST-CN-UNIQUE', courier: 'TCS', version: b.version }, staff), (e: any) => e.status === 403);
  const packed = ops.packOrder(a.id, verify(a).version, staff); const sent = ops.dispatchOrder(a.id, { version: packed.version, handoverConfirmed: true }, staff);
  assert.throws(() => ops.assignCN(b.id, { cn: '000TEST-1234', courier: 'TCS', version: b.version }, owner), (e: any) => e.code === 'DUPLICATE_CN');
  assert.throws(() => ops.dispatchOrder(sent.id, { version: sent.version, handoverConfirmed: true }, staff), (e: any) => e.status === 409);
});
test('packing requires a CN, exact quantities, attribute confirmation and current version', () => {
  let order = imported(); assert.throws(() => ops.packOrder(order.id, order.version, staff), /courier/);
  order = assign(order); assert.throws(() => ops.packOrder(order.id, order.version, staff), /Verify every/);
  assert.throws(() => ops.saveVerification(order.id, { version: order.version, items: [{ id: order.items[0].id, quantity: 3, checked: true }] }, staff), /cannot exceed/);
  assert.throws(() => ops.saveVerification(order.id, { version: order.version, items: [{ id: order.items[0].id, quantity: 1, checked: true }] }, staff), /full quantity/);
  const stale = order.version; order = verify(order); assert.throws(() => ops.saveVerification(order.id, { version: stale, items: [{ id: order.items[0].id, quantity: 2, checked: true }] }, staff), (e: any) => e.code === 'STALE_VERSION');
  order = ops.packOrder(order.id, order.version, staff); assert.equal(order.status, 'packed'); assert.equal(order.packedBy, staff.name);
  assert.throws(() => ops.dispatchOrder(order.id, { version: order.version, handoverConfirmed: false }, staff), /physically received/);
  const sent = ops.dispatchOrder(order.id, { version: order.version, handoverConfirmed: true }, staff); assert.equal(sent.status, 'dispatched'); assert.equal(sent.dispatchedBy, staff.name);
  const job = db.prepare('SELECT * FROM jobs WHERE order_id=?').get(order.id) as any; assert.equal(job.status, 'queued');
  const event = db.prepare("SELECT detail FROM events WHERE order_id=? AND type='ORDER_DISPATCHED'").get(order.id) as any; assert.equal(JSON.parse(event.detail).units, 2);
});
test('unpaid orders are blocked unless Shopify identifies a COD gateway', () => {
  const s = source({ displayFinancialStatus: 'PENDING', paymentGatewayNames: ['Cash on Delivery (COD)'] }); ops.upsertShopifyOrder(s, owner);
  ops.updateOperational({ allowCOD: true }, owner);
  let order = assign(ops.getOrder(s.id, owner).order); order = verify(order);
  ops.updateOperational({ allowCOD: false }, owner);
  assert.throws(() => ops.packOrder(order.id, order.version, staff), /Payment is PENDING/);
  ops.updateOperational({ allowCOD: true }, owner); ops.packOrder(order.id, order.version, staff); ops.updateOperational({ allowCOD: false }, owner);
  const other = source({ displayFinancialStatus: 'PENDING', paymentGatewayNames: ['Bank Deposit'] }); ops.upsertShopifyOrder(other, owner);
  let unpaid = assign(ops.getOrder(other.id, owner).order); assert.throws(() => verify(unpaid), /Payment is PENDING/);
  assert.throws(() => ops.packOrder(unpaid.id, unpaid.version, staff), /Payment is PENDING/);
});
test('midnight carry-forward is idempotent, daily checks are attributable, dispatch resolves history', () => {
  let order = imported(); const today = ops.localDay(); const yesterday = ops.addDays(today, -1); const twoDaysAgo = ops.addDays(today, -2);
  db.prepare('UPDATE orders SET due_date=? WHERE id=?').run(twoDaysAgo, order.id);
  ops.rollPending(today); ops.rollPending(today);
  assert.equal((db.prepare('SELECT count(*) AS n FROM daily_pending WHERE order_id=?').get(order.id) as any).n, 2);
  order = ops.checkPending(order.id, { note: 'Test: physically located on the pending shelf.', stillOutstanding: true }, staff);
  assert.equal((db.prepare('SELECT count(*) AS n FROM daily_pending WHERE order_id=?').get(order.id) as any).n, 3);
  assert.equal(order.checkedBy, staff.name); assert.ok(order.checkedAt);
  order = assign(order); order = verify(order); order = ops.packOrder(order.id, order.version, staff); ops.dispatchOrder(order.id, { version: order.version, handoverConfirmed: true }, staff);
  assert.equal((db.prepare('SELECT count(*) AS n FROM daily_pending WHERE order_id=? AND resolved_at IS NULL').get(order.id) as any).n, 0);
  assert.equal(ops.pendingHistory(1, 30, yesterday).rows.length, 1);
});
test('a Shopify edit invalidates packing verification but preserves dispatched product history', () => {
  let order = assign(imported()); order = verify(order); order = ops.packOrder(order.id, order.version, staff);
  const s = source({ id: order.id, updatedAt: new Date(Date.now() + 1000).toISOString(), lineItems: { nodes: [{ ...source().lineItems.nodes[0], id: order.items[0].id, currentQuantity: 3, quantity: 3 }] } });
  ops.upsertShopifyOrder(s, owner); let refreshed = ops.getOrder(order.id, owner).order;
  assert.equal(refreshed.status, 'ready'); assert.equal(refreshed.items[0].verifiedQuantity, 0); assert.equal(refreshed.items[0].currentQuantity, 3);
  refreshed = verify(refreshed); refreshed = ops.packOrder(refreshed.id, refreshed.version, staff); refreshed = ops.dispatchOrder(refreshed.id, { version: refreshed.version, handoverConfirmed: true }, staff);
  const edit = source({ id: order.id, updatedAt: new Date(Date.now() + 2000).toISOString(), lineItems: { nodes: [{ ...source().lineItems.nodes[0], id: order.items[0].id, currentQuantity: 5, quantity: 5 }] } }); ops.upsertShopifyOrder(edit, owner);
  const historical = ops.getOrder(order.id, owner).order; assert.equal(historical.status, 'dispatched'); assert.equal(historical.items[0].currentQuantity, 3);
  assert.ok(ops.getOrder(order.id, owner).events.some(e => e.type === 'ORDER_UPDATED' && e.detail.afterDispatch === true));
});
test('external fulfillment and cancellations require review, never become invented staff handovers', () => {
  const s = source({ displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ trackingInfo: [{ number: 'TEST-EXTERNAL-CN', company: 'TCS' }] }] }); ops.upsertShopifyOrder(s, owner);
  let order = ops.getOrder(s.id, owner).order; assert.equal(order.status, 'review'); assert.equal(order.cn, 'TEST-EXTERNAL-CN');
  assert.throws(() => ops.resolveReview(order.id, { version: order.version, resolution: 'dispatched', evidence: 'Short' }, owner), /at least 8/);
  assert.throws(() => ops.resolveReview(order.id, { version: order.version, resolution: 'dispatched', evidence: 'Manifest TEST-12345' }, staff), /owner/);
  order = ops.resolveReview(order.id, { version: order.version, resolution: 'outstanding', evidence: 'Shopify fulfilled externally; physical parcel still being investigated.' }, owner); assert.equal(order.status, 'review');
  order = ops.resolveReview(order.id, { version: order.version, resolution: 'dispatched', evidence: 'Verified courier manifest TEST-12345.' }, owner); assert.equal(order.status, 'dispatched'); assert.equal(order.shopifySyncStatus, 'external');
  const cancelled = source({ cancelledAt: new Date().toISOString() }); ops.upsertShopifyOrder(cancelled, owner); const held = ops.getOrder(cancelled.id, owner).order; assert.equal(held.status, 'review'); assert.match(ops.paymentIssue(ops.rawOrder(held.id)!), /cancelled/);
});
test('consistent automatic backup passes SQLite integrity and foreign-key checks', async () => {
  const backup = await createBackup('Isolated test backup'); const file = path.join(directory, 'backups', backup.filename); assert.ok(fs.existsSync(file));
  const bytes = fs.readFileSync(file); assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), backup.sha256);
  const Database = (await import('better-sqlite3')).default; const copy = new Database(file, { readonly: true });
  assert.deepEqual(copy.pragma('integrity_check'), [{ integrity_check: 'ok' }]); assert.deepEqual(copy.pragma('foreign_key_check'), []); copy.close();
});
