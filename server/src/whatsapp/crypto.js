// Cifra segredos de clientes (token da Meta, app secret) com AES-256-GCM.
// A chave (32 bytes em base64) vem do ambiente do serviço e nunca vai ao banco nem ao git.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function parseKey(b64) {
  const k = Buffer.from(String(b64 || ''), 'base64');
  if (k.length !== 32) throw new Error('KOBLY_SECRET_KEY deve ter 32 bytes em base64');
  return k;
}
export function encrypt(plain, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}
export function decrypt(blob, key) {
  const [v, iv, tag, ct] = String(blob || '').split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('segredo em formato inválido');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
