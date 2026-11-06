import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.js';

export const dbPath = path.join(config.dataDir, 'mettwear.sqlite');
export const db = new Database(dbPath);
fs.chmodSync(dbPath, 0o600);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 10000');
db.pragma('synchronous = FULL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','supervisor','staff')),
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_login_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, numeric_id TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, imported_at TEXT NOT NULL,
    customer_name TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', customer_secure TEXT NOT NULL DEFAULT '',
    financial_status TEXT NOT NULL DEFAULT '', fulfillment_status TEXT NOT NULL DEFAULT '', cancelled_at TEXT,
    tags TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '', total TEXT NOT NULL DEFAULT '0', currency TEXT NOT NULL DEFAULT '',
    gateways TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','packed','dispatched','review')),
    cn TEXT NOT NULL DEFAULT '', cn_key TEXT UNIQUE, courier TEXT NOT NULL DEFAULT '', tracking_url TEXT NOT NULL DEFAULT '', cn_conflict TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1, due_date TEXT NOT NULL, first_queued_at TEXT NOT NULL,
    packed_at TEXT, packed_by TEXT REFERENCES users(id), dispatched_at TEXT, dispatched_by TEXT REFERENCES users(id),
    review_reason TEXT NOT NULL DEFAULT '', shopify_sync_status TEXT NOT NULL DEFAULT 'not_requested', shopify_sync_error TEXT,
    source_fingerprint TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS orders_status ON orders(status, due_date);
  CREATE INDEX IF NOT EXISTS orders_name ON orders(name);
  CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);
  CREATE INDEX IF NOT EXISTS orders_dispatched ON orders(dispatched_at);
  CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    title TEXT NOT NULL, variant TEXT NOT NULL DEFAULT '', size TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '',
    sku TEXT NOT NULL DEFAULT '', barcode TEXT NOT NULL DEFAULT '', quantity INTEGER NOT NULL, current_quantity INTEGER NOT NULL,
    requires_shipping INTEGER NOT NULL DEFAULT 1, verified_quantity INTEGER NOT NULL DEFAULT 0,
    attributes_verified INTEGER NOT NULL DEFAULT 0, verified_by TEXT REFERENCES users(id), verified_at TEXT
  );
  CREATE INDEX IF NOT EXISTS items_order ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS items_sku ON order_items(sku);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT REFERENCES orders(id), actor_id TEXT REFERENCES users(id),
    actor_name TEXT NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_order ON events(order_id, id);
  CREATE INDEX IF NOT EXISTS events_actor ON events(actor_id, created_at);
  CREATE INDEX IF NOT EXISTS events_type_time ON events(type, created_at);
  CREATE TABLE IF NOT EXISTS daily_pending (
    day TEXT NOT NULL, order_id TEXT NOT NULL REFERENCES orders(id), status TEXT NOT NULL,
    checked_at TEXT, checked_by TEXT REFERENCES users(id), note TEXT NOT NULL DEFAULT '', resolved_at TEXT,
    created_at TEXT NOT NULL, PRIMARY KEY(day, order_id)
  );
  CREATE INDEX IF NOT EXISTS pending_open ON daily_pending(resolved_at, day);
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), type TEXT NOT NULL DEFAULT 'fulfillment',
    status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL, last_error TEXT, idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, next_attempt_at);
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY, topic TEXT NOT NULL, order_id TEXT NOT NULL, received_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY, filename TEXT NOT NULL, created_at TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL
  );
`);

// Additive migration for databases created by the initial 1.0 build.
if (!(db.pragma('table_info(jobs)') as { name: string }[]).some(column => column.name === 'payload')) db.exec("ALTER TABLE jobs ADD COLUMN payload TEXT NOT NULL DEFAULT '[]'");

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as T : fallback;
}
export function setSetting(key: string, value: unknown) {
  db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
}
export function recordEvent(orderId: string | null, actor: { id: string; name: string } | null, type: string, detail: Record<string, unknown> = {}, at = new Date().toISOString()) {
  db.prepare('INSERT INTO events(order_id,actor_id,actor_name,type,detail,created_at) VALUES (?,?,?,?,?,?)')
    .run(orderId, actor?.id || null, actor?.name || 'Mettwear system', type, JSON.stringify(detail), at);
}
export async function createBackup(reason = 'Scheduled daily backup') {
  const id = crypto.randomUUID();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `mettwear-${stamp}-${id.slice(0, 8)}.sqlite`;
  const target = path.join(config.dataDir, 'backups', filename);
  await db.backup(target);
  fs.chmodSync(target, 0o600);
  const bytes = fs.readFileSync(target);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const created_at = new Date().toISOString();
  db.prepare('INSERT INTO backups(id,filename,created_at,size,sha256) VALUES (?,?,?,?,?)').run(id, filename, created_at, bytes.length, sha256);
  recordEvent(null, null, 'BACKUP_CREATED', { filename, bytes: bytes.length, reason });
  setSetting('lastBackupAt', created_at);
  const old = db.prepare('SELECT * FROM backups WHERE created_at < ?').all(new Date(Date.now() - config.backupRetention * 86400000).toISOString()) as any[];
  for (const backup of old) {
    const file = path.join(config.dataDir, 'backups', path.basename(backup.filename));
    if (fs.existsSync(file)) fs.unlinkSync(file);
    db.prepare('DELETE FROM backups WHERE id = ?').run(backup.id);
  }
  return { id, filename, createdAt: created_at, size: bytes.length, sha256 };
}
