import crypto from 'node:crypto';
import { encryptionKey } from './config.js';

const scrypt = (password: string, salt: string, options?: crypto.ScryptOptions) => new Promise<Buffer>((resolve, reject) => {
  crypto.scrypt(password, salt, 64, options || { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});
export const randomToken = () => crypto.randomBytes(32).toString('hex');
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
export const normalizeCN = (value: string) => value.trim().toUpperCase().replace(/\s+/g, '');
export const now = () => new Date().toISOString();

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt);
  return `scrypt:32768:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const parts = stored.split(':');
  if (parts[0] !== 'scrypt' || parts.length < 3 || parts.length > 4) return false;
  const salt = parts.length === 4 ? parts[2] : parts[1];
  const hash = parts[parts.length - 1];
  if (!salt || !/^[a-f0-9]{128}$/.test(hash)) return false;
  const key = await scrypt(password, salt, parts.length === 3 ? { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } : undefined);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}
export function encrypt(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}
export function decrypt(value: string) {
  const [version, iv, tag, data] = value.split(':');
  if (version !== 'v1') throw new Error('Unsupported encrypted data version.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
export function verifyWebhook(raw: Buffer, signature: string | undefined, secret: string) {
  if (!signature || !secret || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'base64'));
}
export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_ERROR') { super(message); }
}
export function assert(condition: unknown, status: number, message: string, code?: string): asserts condition {
  if (!condition) throw new AppError(status, message, code);
}
