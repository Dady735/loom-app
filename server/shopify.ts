import crypto from 'node:crypto';
import { config } from './config.js';
import { db, getSetting, setSetting, recordEvent } from './db.js';
import { AppError, assert, now, normalizeCN } from './security.js';
import { getCredentials, saveCredentials, upsertShopifyOrder, rawOrder, verifiedItems, getOperational, type ShopifyOrder, type Row } from './operations.js';

const ORDER_FIELDS = `
  id name legacyResourceId createdAt updatedAt displayFinancialStatus displayFulfillmentStatus cancelledAt tags note paymentGatewayNames
  totalPriceSet { shopMoney { amount currencyCode } }
  customer { firstName lastName displayName } email phone
  shippingAddress { name address1 address2 city province country zip phone }
  fulfillments { id status trackingInfo { number company url } }
  lineItems(first:100) { nodes { id title quantity currentQuantity requiresShipping sku variantTitle variant { barcode selectedOptions { name value } } } pageInfo { hasNextPage endCursor } }
`;
const ORDER_QUERY = `query MettwearOrders($first:Int!,$after:String,$query:String!) {
  orders(first:$first,after:$after,query:$query,sortKey:UPDATED_AT) { nodes { ${ORDER_FIELDS} } pageInfo { hasNextPage endCursor } }
}`;
const SINGLE_ORDER_QUERY = `query MettwearOrder($id:ID!) { order(id:$id) { ${ORDER_FIELDS} } }`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function shopifyGraphql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const credentials = getCredentials();
  assert(credentials, 400, 'Connect your Shopify store in Settings first.');
  for (let attempt = 0; attempt < 4; attempt++) {
    let response: Response;
    try {
      response = await fetch(`https://${credentials.domain}/admin/api/${config.shopifyVersion}/graphql.json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': credentials.token },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000), redirect: 'error',
      });
    } catch { throw new AppError(502, 'Could not reach Shopify. Check the server connection and try again.', 'SHOPIFY_NETWORK'); }
    if (response.status === 429 || response.status >= 500) {
      if (attempt < 3) { await delay(Math.min(8000, Number(response.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt)); continue; }
      throw new AppError(502, `Shopify is temporarily unavailable (HTTP ${response.status}). Your place in the import is saved.`, 'SHOPIFY_UNAVAILABLE');
    }
    if (!response.ok) throw new AppError(502, response.status === 401 || response.status === 403 ? 'Shopify rejected the access token. Check the custom-app credentials and Admin API scopes.' : `Shopify returned HTTP ${response.status}. Check the store domain and API version.`, 'SHOPIFY_AUTH');
    const body = await response.json() as any;
    if (body.errors?.length) {
      if (body.errors.some((e: any) => e.extensions?.code === 'THROTTLED') && attempt < 3) { await delay(1000 * 2 ** attempt); continue; }
      const message = body.errors.map((e: any) => e.message).join('; ').replace(/shpat_[A-Za-z0-9_]+/g, '[redacted]').slice(0, 600);
      throw new AppError(502, `Shopify: ${message}`, 'SHOPIFY_GRAPHQL');
    }
    assert(body.data, 502, 'Shopify returned no data. No orders were changed.');
    const cost = body.extensions?.cost;
    if (cost?.currentlyAvailable < 150) await delay(Math.max(500, (150 - cost.currentlyAvailable) / (cost.restoreRate || 50) * 1000));
    return body.data as T;
  }
  throw new AppError(502, 'Shopify rate limit reached. Retry shortly.');
}
export async function testShopify(domain: string, token: string) {
  assert(/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(domain), 400, 'Use your permanent your-store.myshopify.com domain, not a custom domain.');
  assert(token.length >= 20 && token.length < 500 && !/\s/.test(token), 400, 'Enter the Admin API access token from your Shopify custom app.');
  // Test without replacing the active connection, so background imports remain safe.
  let response: Response;
  try {
    response = await fetch(`https://${domain}/admin/api/${config.shopifyVersion}/graphql.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: 'query { shop { name myshopifyDomain } }' }), signal: AbortSignal.timeout(20000), redirect: 'error',
    });
  } catch { throw new AppError(502, 'Could not reach Shopify. Check the domain and the server’s internet connection.'); }
  if (!response.ok) throw new AppError(502, response.status === 401 || response.status === 403 ? 'Shopify rejected this token. Check the custom-app credentials and scopes.' : `Shopify returned HTTP ${response.status}. Check the domain and API version.`);
  const body = await response.json() as any;
  if (body.errors?.length) throw new AppError(502, `Shopify: ${body.errors.map((e: any) => e.message).join('; ').replace(/shpat_[A-Za-z0-9_]+/g, '[redacted]').slice(0,500)}`);
  const shop = body.data?.shop;
  assert(shop?.myshopifyDomain === domain, 400, 'The token belongs to a different Shopify store.');
  return shop as { name: string; myshopifyDomain: string };
}
async function completeLines(order: ShopifyOrder) {
  let connection: any = order.lineItems;
  while (connection.pageInfo.hasNextPage) {
    const result = await shopifyGraphql<any>(`query($id:ID!,$after:String!) { order(id:$id) { lineItems(first:100,after:$after) { nodes { id title quantity currentQuantity requiresShipping sku variantTitle variant { barcode selectedOptions { name value } } } pageInfo { hasNextPage endCursor } } } }`, { id: order.id, after: connection.pageInfo.endCursor });
    assert(result.order, 502, 'A Shopify order disappeared during import. Retry the sync.');
    connection = result.order.lineItems;
    order.lineItems.nodes.push(...connection.nodes);
  }
  return order;
}
export async function fetchShopifyOrder(id: string) {
  assert(/^gid:\/\/shopify\/Order\/\d+$/.test(id), 400, 'Invalid Shopify order ID.');
  const result = await shopifyGraphql<{ order: ShopifyOrder | null }>(SINGLE_ORDER_QUERY, { id });
  assert(result.order, 404, 'Shopify could not find this order with the current API permissions.');
  return completeLines(result.order);
}
let syncBusy = false;
export const isSyncing = () => syncBusy;
export async function syncOrders(actor: { id: string; name: string } | null, mode: 'incremental' | 'rescan' = 'incremental') {
  if (syncBusy) return { running: true, imported: 0, updated: 0, complete: false };
  assert(getCredentials(), 400, 'Connect Shopify in Settings before importing orders.');
  syncBusy = true;
  let imported = 0, updated = 0, pages = 0;
  const startedAt = now();
  try {
    let state = getSetting<any>('syncState', null);
    if (mode === 'rescan' && !state) state = null;
    if (!state) {
      const last = getSetting<string | null>('lastSyncAt', null);
      const initial = !last || mode === 'rescan';
      const since = initial ? new Date(Date.now() - config.importDays * 86400000).toISOString() : new Date(new Date(last!).getTime() - 120000).toISOString();
      state = { initial, query: initial ? `status:open created_at:>='${since}'` : `updated_at:>='${since}'`, cursor: null, startedAt };
      setSetting('syncState', state);
    }
    recordEvent(null, actor, 'SYNC_STARTED', { query: state.query, resumed: !!state.cursor });
    while (pages < 200) {
      const result = await shopifyGraphql<any>(ORDER_QUERY, { first: 25, after: state.cursor, query: state.query });
      const connection = result.orders;
      assert(connection?.nodes && connection.pageInfo, 502, 'Shopify returned an invalid orders page.');
      for (const shortOrder of connection.nodes) {
        const order = await completeLines(structuredClone(shortOrder));
        const result = upsertShopifyOrder(order, actor);
        if (result.created) imported++; else if (!result.skipped) updated++;
      }
      pages++;
      state.cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
      setSetting('syncState', connection.pageInfo.hasNextPage ? state : null);
      if (!connection.pageInfo.hasNextPage) {
        setSetting('lastSyncAt', state.startedAt); setSetting('lastSyncError', null);
        recordEvent(null, actor, 'SYNC_COMPLETED', { imported, updated, pages, complete: true });
        return { running: false, imported, updated, complete: true };
      }
    }
    recordEvent(null, actor, 'SYNC_PAUSED', { imported, updated, pages, reason: 'Page budget reached; cursor saved for the next run.' });
    return { running: false, imported, updated, complete: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Shopify import failed.';
    setSetting('lastSyncError', message);
    recordEvent(null, actor, 'SYNC_FAILED', { message, imported, updated, cursorSaved: !!getSetting('syncState', null) });
    throw error;
  } finally { syncBusy = false; }
}
export async function registerWebhooks(actor: { id: string; name: string }) {
  const credentials = getCredentials(); assert(credentials, 400, 'Connect Shopify first.');
  assert(config.publicUrl.startsWith('https://'), 400, 'Set PUBLIC_URL to the public HTTPS address before enabling live webhooks. The import scheduler works without webhooks.');
  assert(credentials.secret.length >= 16, 400, 'Add the custom app Client secret in Settings to verify Shopify webhook signatures.');
  const topics = ['ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_FULFILLED', 'ORDERS_CANCELLED', 'ORDERS_EDITED'];
  const uri = `${config.publicUrl}/api/webhooks/shopify`;
  const ids: string[] = [];
  for (let i = 0; i < topics.length; i++) {
    const existing = credentials.webhookIds[i];
    if (existing) {
      try {
        const result = await shopifyGraphql<any>(`mutation($id:ID!,$subscription:WebhookSubscriptionInput!) { webhookSubscriptionUpdate(id:$id,webhookSubscription:$subscription) { webhookSubscription { id } userErrors { field message } } }`, { id: existing, subscription: { uri, format: 'JSON' } });
        const payload = result.webhookSubscriptionUpdate;
        assert(!payload.userErrors?.length, 502, payload.userErrors?.map((e: any) => e.message).join('; ') || 'Webhook update failed.');
        ids.push(payload.webhookSubscription.id); continue;
      } catch (error) { if (!(error instanceof AppError) || !/not found|invalid id|does not exist/i.test(error.message)) throw error; }
    }
    const result = await shopifyGraphql<any>(`mutation($topic:WebhookSubscriptionTopic!,$subscription:WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic:$topic,webhookSubscription:$subscription) { webhookSubscription { id } userErrors { field message } } }`, { topic: topics[i], subscription: { uri, format: 'JSON', name: 'Mettwear operations' } });
    const payload = result.webhookSubscriptionCreate;
    assert(!payload.userErrors?.length, 502, payload.userErrors?.map((e: any) => e.message).join('; ') || 'Could not register webhook.');
    ids.push(payload.webhookSubscription.id);
    saveCredentials({ ...getCredentials()!, webhookIds: [...ids] });
  }
  saveCredentials({ ...getCredentials()!, webhookIds: ids });
  recordEvent(null, actor, 'WEBHOOKS_REGISTERED', { topics, uri });
}
export async function receiveWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>) {
  const credentials = getCredentials(); assert(credentials?.secret, 503, 'Webhooks are not configured.');
  const domain = String(headers['x-shopify-shop-domain'] || '');
  const signature = String(headers['x-shopify-hmac-sha256'] || '');
  const deliveryId = String(headers['x-shopify-webhook-id'] || '');
  const topic = String(headers['x-shopify-topic'] || '');
  const { verifyWebhook } = await import('./security.js');
  assert(domain === credentials.domain && verifyWebhook(raw, signature, credentials.secret), 401, 'Invalid webhook signature.');
  assert(deliveryId && topic.startsWith('orders/'), 400, 'Invalid webhook delivery.');
  if (db.prepare('SELECT id FROM webhook_deliveries WHERE id=?').get(deliveryId)) return;
  let payload: any;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { throw new AppError(400, 'Invalid JSON.'); }
  const id = payload.admin_graphql_api_id || (payload.id ? `gid://shopify/Order/${payload.id}` : '');
  assert(/^gid:\/\/shopify\/Order\/\d+$/.test(id), 400, 'Invalid order reference.');
  if (topic === 'orders/fulfilled') {
    // A fulfillment webhook is a signal to refresh its parent order, not proof of our staff's handover.
    const parent = raw.toString('utf8').match(/gid:\/\/shopify\/Order\/\d+/);
    if (payload.order_id) await receiveOrderWebhook(`gid://shopify/Order/${payload.order_id}`, deliveryId, topic);
    return;
  }
  await receiveOrderWebhook(id, deliveryId, topic);
}
async function receiveOrderWebhook(id: string, deliveryId: string, topic: string) {
  const order = await fetchShopifyOrder(id);
  db.transaction(() => {
    upsertShopifyOrder(order, null, `Shopify webhook: ${topic}`);
    db.prepare('INSERT OR IGNORE INTO webhook_deliveries(id,topic,order_id,received_at) VALUES (?,?,?,?)').run(deliveryId, topic, id, now());
    setSetting('lastWebhookAt', now());
  })();
}
const FULFILLMENT_QUERY = `query($id:ID!) { order(id:$id) {
  id displayFulfillmentStatus cancelledAt fulfillments { id status trackingInfo { number company url } }
  fulfillmentOrders(first:50,includeClosed:false) {
    nodes { id status fulfillAt assignedLocation { name location { id } }
      lineItems(first:100) { nodes { id remainingQuantity totalQuantity requiresShipping } pageInfo { hasNextPage endCursor } }
    } pageInfo { hasNextPage endCursor }
  }
} }`;
async function allFulfillmentOrders(id: string) {
  const result = await shopifyGraphql<any>(FULFILLMENT_QUERY, { id }); assert(result.order, 404, 'Order no longer exists in Shopify.');
  const order = result.order;
  assert(!order.fulfillmentOrders.pageInfo.hasNextPage, 409, 'This order has more than 50 fulfillment locations/groups. Reconcile it manually in Shopify.');
  for (const fo of order.fulfillmentOrders.nodes) {
    while (fo.lineItems.pageInfo.hasNextPage) {
      const next = await shopifyGraphql<any>(`query($id:ID!,$after:String!) { fulfillmentOrder(id:$id) { lineItems(first:100,after:$after) { nodes { id remainingQuantity totalQuantity requiresShipping } pageInfo { hasNextPage endCursor } } } }`, { id: fo.id, after: fo.lineItems.pageInfo.endCursor });
      assert(next.fulfillmentOrder, 409, 'Shopify fulfillment group changed during dispatch.');
      fo.lineItems.nodes.push(...next.fulfillmentOrder.lineItems.nodes); fo.lineItems.pageInfo = next.fulfillmentOrder.lineItems.pageInfo;
    }
  }
  return order;
}
class BlockedJob extends Error {}
let jobsBusy = false;
export async function processJobs() {
  if (jobsBusy || !getCredentials()) return;
  jobsBusy = true;
  let claimed: Row | undefined;
  try {
    const at = now();
    claimed = db.transaction(() => {
      const job = db.prepare("SELECT * FROM jobs WHERE status='queued' AND next_attempt_at<=? ORDER BY created_at LIMIT 1").get(at) as Row | undefined;
      if (job) db.prepare("UPDATE jobs SET status='running',attempts=attempts+1,updated_at=? WHERE id=?").run(at, job.id);
      return job;
    })();
    if (!claimed) return;
    const local = rawOrder(claimed.order_id);
    assert(local?.status === 'dispatched', 409, 'Local dispatch record is missing.');
    // Never fulfill products added/refunded in Shopify after the physical packing check.
    const currentOrder = await fetchShopifyOrder(local.id);
    if (currentOrder.cancelledAt) throw new BlockedJob('Order cancelled in Shopify after handover. Investigate the physical parcel and Shopify fulfillment.');
    const expected: { id: string; quantity: number }[] = JSON.parse(claimed.payload || '[]');
    const expectedLines = expected.length ? expected : verifiedItems(local.id).map(i => ({ id: i.id, quantity: i.current_quantity }));
    const currentLines = currentOrder.lineItems.nodes.filter(i => i.requiresShipping && i.currentQuantity > 0).map(i => ({ id: i.id, quantity: i.currentQuantity })).sort((a,b) => a.id.localeCompare(b.id));
    if (JSON.stringify([...expectedLines].sort((a,b) => a.id.localeCompare(b.id))) !== JSON.stringify(currentLines)) throw new BlockedJob('Shopify products or quantities changed after packing. Nothing new was fulfilled. Resolve the order in Shopify and reconcile the physical parcel before retrying.');
    const source = await allFulfillmentOrders(local.id);
    if (source.cancelledAt) throw new BlockedJob('Order cancelled in Shopify after handover. Investigate the physical parcel and Shopify fulfillment.');
    const locations = new Set<string>();
    for (const fo of source.fulfillmentOrders.nodes) {
      if (!['OPEN', 'IN_PROGRESS'].includes(fo.status)) throw new BlockedJob(`Shopify fulfillment group is ${fo.status}. Release the hold or schedule in Shopify, then retry.`);
      if (fo.fulfillAt && new Date(fo.fulfillAt).getTime() > Date.now()) throw new BlockedJob('This fulfillment is scheduled for a future date in Shopify.');
      const items = fo.lineItems.nodes.filter((i: any) => i.requiresShipping && i.remainingQuantity > 0);
      if (!items.length) continue;
      const location = fo.assignedLocation?.location?.id || fo.assignedLocation?.name;
      if (!location) throw new BlockedJob('No accessible merchant-managed fulfillment location. Check API scopes and fulfillment assignment.');
      locations.add(location);
    }
    const trackingMatches = source.fulfillments?.some((f: any) => f.trackingInfo?.some((t: any) => t.number && normalizeCN(t.number) === normalizeCN(local.cn)));
    if (!locations.size) {
      if (source.displayFulfillmentStatus !== 'FULFILLED' || !trackingMatches) throw new BlockedJob('No accessible open fulfillment lines, but Shopify does not show a fulfilled order with this CN. Reconcile manually.');
    }
    const fulfillmentIds: string[] = [];
    for (const location of locations) {
      // Multiple open fulfillment orders at one location must remain separate input entries.
      const entries = source.fulfillmentOrders.nodes.filter((fo: any) => (fo.assignedLocation?.location?.id || fo.assignedLocation?.name) === location).map((fo: any) => ({
        fulfillmentOrderId: fo.id,
        fulfillmentOrderLineItems: fo.lineItems.nodes.filter((i: any) => i.requiresShipping && i.remainingQuantity > 0).map((i: any) => ({ id: i.id, quantity: i.remainingQuantity })),
      })).filter((g: any) => g.fulfillmentOrderLineItems.length);
      const key = `${claimed.idempotency_key}:${crypto.createHash('sha256').update(location).digest('hex').slice(0, 24)}`;
      const result = await shopifyGraphql<any>(`mutation($fulfillment:FulfillmentInput!) { fulfillmentCreate(fulfillment:$fulfillment) @idempotent(key:$key) { fulfillment { id status } userErrors { field message } } }`.replace('@idempotent(key:$key)', `@idempotent(key:"${key}")`), {
        fulfillment: { lineItemsByFulfillmentOrder: entries, trackingInfo: { number: local.cn, company: local.courier, ...(local.tracking_url ? { url: local.tracking_url } : {}) }, notifyCustomer: getOperational().notifyCustomer },
      });
      const payload = result.fulfillmentCreate;
      if (payload.userErrors?.length) throw new BlockedJob(payload.userErrors.map((e: any) => `${e.field || 'Shopify'}: ${e.message}`).join('; '));
      assert(payload.fulfillment?.id, 502, 'Shopify did not confirm the fulfillment.');
      fulfillmentIds.push(payload.fulfillment.id);
    }
    db.transaction(() => {
      db.prepare("UPDATE jobs SET status='done',last_error=NULL,updated_at=? WHERE id=?").run(now(), claimed!.id);
      db.prepare("UPDATE orders SET shopify_sync_status='synced',shopify_sync_error=NULL,fulfillment_status='FULFILLED',version=version+1 WHERE id=?").run(local.id);
      recordEvent(local.id, null, 'SHOPIFY_FULFILLED', { cn: local.cn, fulfillmentIds, idempotencyKey: claimed!.idempotency_key });
    })();
  } catch (error) {
    if (claimed) {
      const message = (error instanceof Error ? error.message : 'Shopify fulfillment failed.').slice(0, 1000);
      const blocked = error instanceof BlockedJob || (error instanceof AppError && ['SHOPIFY_AUTH', 'SHOPIFY_GRAPHQL'].includes(error.code));
      const terminal = blocked || claimed.attempts >= 8;
      db.transaction(() => {
        db.prepare('UPDATE jobs SET status=?,last_error=?,next_attempt_at=?,updated_at=? WHERE id=?').run(blocked ? 'blocked' : terminal ? 'failed' : 'queued', message, new Date(Date.now() + Math.min(3600000, 15000 * 2 ** claimed!.attempts)).toISOString(), now(), claimed!.id);
        db.prepare('UPDATE orders SET shopify_sync_status=?,shopify_sync_error=? WHERE id=?').run(blocked ? 'blocked' : terminal ? 'failed' : 'retrying', message, claimed!.order_id);
        recordEvent(claimed!.order_id, null, 'SHOPIFY_SYNC_FAILED', { message, attempt: claimed!.attempts, terminal, blocked });
      })();
    }
  } finally { jobsBusy = false; }
}
export function retrySync(id: string, actor: { id: string; name: string }) {
  db.transaction(() => {
    const order = rawOrder(id); assert(order?.status === 'dispatched', 409, 'Only a dispatched order can be synced.');
    assert(order.cn, 409, 'A courier CN is required.');
    const existing = db.prepare('SELECT * FROM jobs WHERE order_id=?').get(id) as Row;
    if (existing) {
      assert(existing.status !== 'done', 409, 'This dispatch is already synced.');
      const payload = existing.payload && existing.payload !== '[]' ? existing.payload : JSON.stringify(verifiedItems(id).map(i => ({ id: i.id, quantity: i.current_quantity })));
      db.prepare("UPDATE jobs SET status='queued',attempts=0,payload=?,next_attempt_at=?,last_error=NULL,updated_at=? WHERE id=?").run(payload, now(), now(), existing.id);
    } else {
      const jobId = crypto.randomUUID();
      const payload = JSON.stringify(verifiedItems(id).map(i => ({ id: i.id, quantity: i.current_quantity })));
      db.prepare("INSERT INTO jobs(id,order_id,idempotency_key,payload,next_attempt_at,created_at,updated_at) VALUES (?,?,'mettwear-'||?,?,?,?,?)").run(jobId, id, jobId, payload, now(), now(), now());
    }
    db.prepare("UPDATE orders SET shopify_sync_status='queued',shopify_sync_error=NULL,version=version+1 WHERE id=?").run(id);
    recordEvent(id, actor, 'SHOPIFY_SYNC_RETRIED');
  })();
}
