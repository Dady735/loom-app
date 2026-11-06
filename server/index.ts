import express from 'express';
import helmet from 'helmet';
import { createServer } from 'node:http';
import path from 'node:path';
import { config, production } from './config.js';
import { createApi, startSchedulers, receiveWebhook, broadcast } from './routes.js';
import { AppError } from './security.js';
import { db } from './db.js';

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', config.trustProxy);
app.use(helmet({
  contentSecurityPolicy: production ? { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https://cdn.shopify.com'], fontSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: [] } } : false,
  frameguard: production ? { action: 'sameorigin' } : false,
  crossOriginEmbedderPolicy: false,
  strictTransportSecurity: production ? { maxAge: 31536000, includeSubDomains: true } : false,
}));
app.post('/api/webhooks/shopify', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  try { await receiveWebhook(req.body as Buffer, req.headers); broadcast(); res.status(200).json({ ok: true }); }
  catch (error) { res.status(error instanceof AppError ? error.status : 502).json({ error: error instanceof AppError ? error.message : 'Shopify webhook processing failed; delivery will be retried.' }); }
});
app.use(express.json({ limit: '2mb' }));
app.use('/api', createApi());
const server = createServer(app);
let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
if (!production) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({ configFile: path.resolve('vite.config.ts'), server: { middlewareMode: true, hmr: { server }, allowedHosts: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const dist = path.resolve('dist');
  app.use(express.static(dist, { maxAge: '1h', index: false }));
  app.get('/{*path}', (_req, res) => { res.set('Cache-Control', 'no-cache').sendFile(path.join(dist, 'index.html')); });
}
const stopSchedulers = startSchedulers();
server.listen(config.port, config.host, () => {
  console.log(`Mettwear Operations is ready at http://${config.host}:${config.port} (${production ? 'production' : 'development'})`);
  console.log(`Database: ${config.dataDir}. Shopify orders are imported only after a live connection is configured.`);
  if (!production && !config.setupToken) console.log('Development first-run setup is open. Production enforces a private SETUP_TOKEN.');
});
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  stopSchedulers();
  server.close();
  await vite?.close();
  db.close();
  server.closeAllConnections();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
