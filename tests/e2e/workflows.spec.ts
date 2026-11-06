import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import crypto from 'node:crypto';

// Browser fixtures are confined to .test-data/e2e, a disposable database created
// by playwright.config.ts. The production/preview database is never touched.
process.env.NODE_ENV = 'test'; process.env.DATA_DIR = path.resolve('.test-data/e2e');
const ownerPassword = 'Browser-test-owner-123!'; const staffPassword = 'Browser-test-staff-123!';
let ops: typeof import('../../server/operations'); let security: typeof import('../../server/security'); let database: typeof import('../../server/db');
let owner: import('../../shared/types').User; let staff: import('../../shared/types').User;
let seeded = false;
const testCN = '000TEST-CN-1042';
async function modules() { if (!ops) { ops = await import('../../server/operations.js'); security = await import('../../server/security.js'); database = await import('../../server/db.js'); } }
function fixture(n: number, title: string, size: string, color: string, quantity = 1) {
  const at = new Date().toISOString();
  return { id: `gid://shopify/Order/${n}`, name: `#MT-${n}`, legacyResourceId: String(n), createdAt: at, updatedAt: at, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', paymentGatewayNames: ['Shopify Payments'], totalPriceSet: { shopMoney: { amount: String(quantity * 1850), currencyCode: 'PKR' } }, customer: { displayName: ['Ayesha Khan', 'Hamza Ali', 'Sara Ahmed', 'Bilal Hassan', 'Noor Fatima', 'Usman Tariq'][n - 1042] }, shippingAddress: { name: 'Browser test customer', city: ['Karachi', 'Lahore', 'Islamabad'][n % 3], address1: 'Isolated browser-test address' }, lineItems: { nodes: [{ id: `gid://shopify/LineItem/${n}`, title, quantity, currentQuantity: quantity, requiresShipping: true, sku: `TEST-${n}-${size}`, variantTitle: `${size} / ${color}`, variant: { barcode: `TEST-ITEM-${n}`, selectedOptions: [{ name: 'Size', value: size }, { name: 'Color', value: color }] } }] }, fulfillments: [] };
}
async function seed() {
  if (seeded) return; await modules();
  const row = database.db.prepare("SELECT * FROM users WHERE role='owner'").get() as any; owner = ops.publicUser(row);
  staff = { id: crypto.randomUUID(), name: 'Sana Shipping', email: 'sana@example.test', role: 'staff', active: true, createdAt: new Date().toISOString(), lastLoginAt: null };
  database.db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)').run(staff.id, staff.name, staff.email, await security.hashPassword(staffPassword), 'staff', staff.createdAt);
  ops.updateOperational({ dispatchToShopify: false }, owner);
  const products = [['Essential Cotton Tee', 'M', 'Ivory'], ['Relaxed Linen Shirt', 'L', 'Sage'], ['Everyday Crewneck', 'S', 'Charcoal'], ['Classic Polo', 'M', 'Navy'], ['Studio Oversized Tee', 'L', 'Black'], ['Weekend Henley', 'M', 'Oat']];
  for (let i = 0; i < products.length; i++) {
    const n = 1042 + i; const [title,size,color] = products[i]; ops.upsertShopifyOrder(fixture(n,title,size,color,i === 0 ? 2 : 1) as any, owner);
    let order = ops.getOrder(`gid://shopify/Order/${n}`, owner).order;
    if (n !== 1043) order = ops.assignCN(order.id, { version: order.version, cn: n === 1042 ? testCN : `TEST-CN-${n}`, courier: ['Leopards','TCS','M&P'][i%3] }, owner);
    if (n >= 1044 && n <= 1046) { order = ops.saveVerification(order.id, { version: order.version, items: order.items.map(item => ({ id: item.id, quantity: item.currentQuantity, checked: true })) }, staff); order = ops.packOrder(order.id, order.version, staff); }
    if (n === 1045) ops.dispatchOrder(order.id, { version: order.version, handoverConfirmed: true }, staff);
    if (n === 1046) { database.db.prepare('UPDATE orders SET due_date=? WHERE id=?').run(ops.addDays(ops.localDay(), -2), order.id); ops.checkPending(order.id, { note: 'Browser test: parcel located on pending shelf B.', stillOutstanding: true }, staff); }
  }
  ops.rollPending(ops.localDay()); seeded = true;
}
async function signIn(page: Page, email: string, password: string) { await page.goto('/'); await page.getByLabel('Email address').fill(email); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in to workspace' }).click(); await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible(); }

test('first-run owner setup, live empty dashboard, and isolated operational fixtures', async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'A better shipping day starts here.' })).toBeVisible();
  await page.screenshot({ path: 'test-results/setup-desktop.png', fullPage: true });
  await page.getByLabel('Your full name').fill('Ali Mettwear'); await page.getByLabel('Email address').fill('ali@example.test'); await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await page.getByRole('button', { name: 'Create owner account' }).click(); await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
  await expect(page.getByText('Your real orders belong here')).toBeVisible(); await expect(page.getByText('No mock orders. No monthly fee.')).toBeVisible();
  await seed(); await page.reload(); await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible(); await expect(page.locator('.stat-value').first()).toHaveText('6');
  await page.waitForTimeout(800); await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
});
test('order search, drawer, duplicate CN feedback and packing-to-dispatch workflow', async ({ page }) => {
  await signIn(page, 'ali@example.test', ownerPassword); await page.goto('/#/orders'); await page.getByLabel('Search orders', { exact: true }).fill('MT-1043');
  await expect(page.locator('tbody tr')).toHaveCount(1); await page.locator('tbody tr').click(); await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Courier CN / tracking number').fill(testCN); await page.getByRole('button', { name: 'Assign courier CN' }).click(); await expect(page.getByText(/Duplicate CN: already assigned/)).toBeVisible();
  await page.getByLabel('Courier CN / tracking number').fill('TEST-CN-1043'); await page.getByRole('button', { name: 'Assign courier CN' }).click(); await expect(page.locator('.cn-display')).toContainText('TEST-CN-1043');
  await page.getByRole('button', { name: 'Close dialog' }).click(); await page.goto('/#/packing'); await page.getByLabel('Scan or enter CN / order number').fill('TEST-CN-1043'); await page.getByRole('button', { name: 'Find order' }).click();
  await expect(page.getByRole('heading', { name: 'Packing #MT-1043' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Mark as Packed', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Increase Relaxed Linen Shirt quantity' }).click(); await page.getByLabel('Product, size & colour match').check(); await page.getByRole('button', { name: 'Mark as Packed', exact: true }).click();
  await expect(page.getByText('Checked, packed, ready to go.')).toBeVisible(); await page.getByRole('button', { name: 'Confirm handover', exact: true }).click();
  await page.getByLabel(/I have handed this parcel/).check(); await page.getByRole('button', { name: 'Mark as dispatched' }).click(); await expect(page.getByText('This parcel has already been dispatched.')).toBeVisible();
});
test('daily pending verification, real Excel download, and team account creation', async ({ page }) => {
  await signIn(page, 'ali@example.test', ownerPassword); await page.goto('/#/pending'); await page.getByLabel('Search pending orders').fill('MT-1046'); await page.getByRole('button', { name: 'Daily check' }).click();
  await page.getByLabel('What did you verify?').fill('Browser test: still on shelf B, waiting for courier pickup.'); await page.getByLabel(/I verified this order is still outstanding/).check(); await page.getByRole('button', { name: 'Record daily check' }).click(); await expect(page.getByText('Daily check recorded. The order remains outstanding.')).toBeVisible();
  await page.getByRole('button', { name: 'Daily register', exact: true }).click(); await expect(page.locator('tbody')).toContainText('Browser test: still on shelf B');
  await page.goto('/#/reports'); const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download order report' }).click(); const file = await downloadPromise; expect(file.suggestedFilename()).toMatch(/mettwear-orders.*\.xlsx/); await file.saveAs('test-results/orders-report.xlsx');
  await page.goto('/#/staff'); await page.getByRole('button', { name: 'Add team member' }).click(); await page.getByLabel('Full name').fill('Omar Packer'); await page.getByLabel('Email address').fill('omar@example.test'); await page.getByLabel('Initial password').fill('Browser-test-omar-123!'); await page.getByRole('button', { name: 'Create account' }).click(); await expect(page.locator('tbody')).toContainText('Omar Packer');
});
test('staff permissions and mobile packing layout', async ({ page }) => {
  await signIn(page, 'sana@example.test', staffPassword); await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0); await expect(page.getByRole('link', { name: 'Team & access' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/#/packing'); await page.getByLabel('Scan or enter CN / order number').fill(testCN); await page.getByRole('button', { name: 'Find order' }).click(); await expect(page.getByRole('heading', { name: 'Packing #MT-1042' })).toBeVisible();
  await expect(page.getByText('Essential Cotton Tee', { exact: true })).toBeVisible(); await expect(page.getByText('TEST-1042-M', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/packing-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Open navigation' }).click(); await expect(page.getByRole('link', { name: 'Pending orders' })).toBeVisible(); await page.getByRole('link', { name: 'Pending orders' }).click(); await expect(page.getByRole('heading', { name: 'Pending orders', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/pending-mobile.png', fullPage: true });
});
test.afterAll(async () => { if (database) database.db.close(); });
