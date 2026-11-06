import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const production = process.env.NODE_ENV === 'production';
export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  setupToken: process.env.SETUP_TOKEN || '',
  trustProxy: Number(process.env.TRUST_PROXY || 0),
  backupRetention: Math.max(2, Number(process.env.BACKUP_RETENTION_DAYS || 14)),
  importDays: Math.min(60, Math.max(1, Number(process.env.SHOPIFY_IMPORT_DAYS || 60))),
  shopifyVersion: process.env.SHOPIFY_API_VERSION || '2026-01',
};
if (production) {
  if (!config.publicUrl.startsWith('https://')) throw new Error('Production requires PUBLIC_URL to be your exact HTTPS origin.');
  if (!process.env.DATA_ENCRYPTION_KEY) throw new Error('Production requires a stable DATA_ENCRYPTION_KEY.');
  if (config.setupToken.length < 24) throw new Error('Production requires a private SETUP_TOKEN of at least 24 characters.');
}
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(config.dataDir, 'backups'), { recursive: true, mode: 0o700 });
let keyText = process.env.DATA_ENCRYPTION_KEY;
if (!keyText) {
  const keyFile = path.join(config.dataDir, '.encryption-key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  keyText = fs.readFileSync(keyFile, 'utf8').trim();
}
export const encryptionKey = Buffer.from(keyText, 'base64');
if (encryptionKey.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must decode to exactly 32 bytes (base64).');
