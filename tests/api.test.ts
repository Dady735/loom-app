import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import ExcelJS from 'exceljs';

const directory = path.resolve('.test-data', `api-${process.pid}`); fs.mkdirSync(directory, { recursive: true });
process.env.NODE_ENV = 'test'; process.env.DATA_DIR = directory; process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64'); process.env.SETUP_TOKEN = 'isolated-api-test-setup-key-123456';
const { db } = await import('../server/db.js'); const { createApi } = await import('../server/routes.js'); const ops = await import('../server/operations.js');
const app = express(); app.use(express.json()); app.use('/api', createApi());
const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
let ownerCookie = '', ownerCsrf = '', staffCookie = '', staffCsrf = '', orderId = '';
function headers(cookie: string, csrf: string, extra: Record<string,string> = {}) { return { 'Content-Type': 'application/json', 'X-Mettwear-Client': 'web', Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...extra }; }
const cookieOf = (response: Response) => (response.headers.get('set-cookie') || '').split(';')[0];
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('first setup requires the private key and rejects cross-origin or unheaded mutations', async () => {
  const body = { name: 'API Owner', email: 'owner@example.test', password: 'isolated-owner-password', setupKey: 'wrong' };
  assert.equal((await fetch(`${base}/api/setup`, { method: 'POST', headers: headers('', ''), body: JSON.stringify(body) })).status, 403);
  assert.equal((await fetch(`${base}/api/setup`, { method: 'POST', headers: headers('', '', { Origin: 'https://untrusted.example' }), body: JSON.stringify(body) })).status, 403);
  assert.equal((await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
  const response = await fetch(`${base}/api/setup`, { method: 'POST', headers: headers('', ''), body: JSON.stringify({ ...body, setupKey: process.env.SETUP_TOKEN }) });
  assert.equal(response.status, 201); ownerCookie = cookieOf(response); const data = await response.json(); ownerCsrf = data.csrf; assert.equal(data.user.role, 'owner'); assert.ok(!JSON.stringify(data).includes('password'));
  assert.match(response.headers.get('set-cookie') || '', /HttpOnly/i); assert.match(response.headers.get('set-cookie') || '', /SameSite=Strict/i);
});
test('authenticated mutations require CSRF and unauthenticated data requests are rejected', async () => {
  assert.equal((await fetch(`${base}/api/orders`)).status, 401);
  assert.equal((await fetch(`${base}/api/shopify/sync`, { method: 'POST', headers: headers(ownerCookie, ''), body: '{}' })).status, 403);
  const response = await fetch(`${base}/api/users`, { method: 'POST', headers: headers(ownerCookie, ownerCsrf), body: JSON.stringify({ name: 'API Staff', email: 'staff@example.test', password: 'isolated-staff-password', role: 'staff' }) });
  assert.equal(response.status, 201);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: headers('', ''), body: JSON.stringify({ email: 'staff@example.test', password: 'isolated-staff-password' }) });
  assert.equal(login.status, 200); staffCookie = cookieOf(login); staffCsrf = (await login.json()).csrf;
});
test('server enforces staff restrictions and never returns customer contact details to staff', async () => {
  const at = new Date().toISOString(); const id = 'gid://shopify/Order/9001'; orderId = id;
  ops.upsertShopifyOrder({ id, name: '#API-9001', createdAt: at, updatedAt: at, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', paymentGatewayNames: ['Shopify Payments'], shippingAddress: { name: 'Private Customer', city: 'Karachi', address1: 'Confidential address', phone: '+920000000000' }, email: 'private@example.test', lineItems: { nodes: [{ id: 'gid://shopify/LineItem/9001', title: 'API test product', quantity: 1, currentQuantity: 1, requiresShipping: true, sku: 'API-TEST', variant: { selectedOptions: [{ name: 'Size', value: 'S' }, { name: 'Color', value: 'Blue' }] } }] } } as any);
  const response = await fetch(`${base}/api/orders/${encodeURIComponent(id)}`, { headers: headers(staffCookie, '') }); const data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.order.customer, undefined); assert.ok(!JSON.stringify(data).includes('Confidential address')); assert.ok(!JSON.stringify(data).includes('private@example.test'));
  assert.equal((await fetch(`${base}/api/settings`, { headers: headers(staffCookie, '') })).status, 403);
  assert.equal((await fetch(`${base}/api/users`, { headers: headers(staffCookie, '') })).status, 403);
  assert.equal((await fetch(`${base}/api/reports/orders`, { headers: headers(staffCookie, '') })).status, 403);
  assert.equal((await fetch(`${base}/api/orders/${encodeURIComponent(id)}/cn`, { method: 'POST', headers: headers(staffCookie, staffCsrf), body: JSON.stringify({ version: data.order.version, cn: 'API-CN-0001', courier: 'TCS' }) })).status, 403);
});
test('Excel export is a real workbook containing imported order and checklist data', async () => {
  const response = await fetch(`${base}/api/reports/orders`, { headers: headers(ownerCookie, '') }); assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /spreadsheetml/); const buffer = Buffer.from(await response.arrayBuffer()); assert.equal(buffer.subarray(0,2).toString(), 'PK');
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer as any);
  assert.ok(workbook.getWorksheet('Orders')); assert.ok(workbook.getWorksheet('Packing checklist')); assert.ok(workbook.getWorksheet('Complete activity history'));
  assert.equal(workbook.getWorksheet('Orders')!.getRow(2).getCell(1).value, '#API-9001'); assert.equal(workbook.getWorksheet('Packing checklist')!.getRow(2).getCell(2).value, 'API test product');
});
test('disabling a staff account revokes its session immediately', async () => {
  const staff = db.prepare("SELECT id FROM users WHERE email='staff@example.test'").get() as any;
  const response = await fetch(`${base}/api/users/${staff.id}`, { method: 'PATCH', headers: headers(ownerCookie, ownerCsrf), body: JSON.stringify({ active: false }) }); assert.equal(response.status, 200);
  assert.equal((await fetch(`${base}/api/orders`, { headers: headers(staffCookie, '') })).status, 401);
});
test('owner backup endpoint creates a consistent downloadable SQLite snapshot', async () => {
  const created = await fetch(`${base}/api/backups`, { method: 'POST', headers: headers(ownerCookie, ownerCsrf), body: '{}' }); assert.equal(created.status, 201); const backup = await created.json();
  const response = await fetch(`${base}/api/backups/${backup.id}/download`, { headers: headers(ownerCookie, '') }); assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), backup.sha256); assert.equal(bytes.subarray(0,15).toString(), 'SQLite format 3');
});
