// JWT HS256 mínimo (o PostgREST valida o mesmo segredo). Sem dependências.
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (data, secret) => createHmac('sha256', secret).update(data).digest();

export function signJwt(payload, secret) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  return `${head}.${body}.${sign(`${head}.${body}`, secret).toString('base64url')}`;
}

export function verifyJwt(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  let header;
  try { header = JSON.parse(Buffer.from(head, 'base64url').toString()); } catch { return null; }
  if (header.alg !== 'HS256') return null; // recusa "none" e qualquer outro algoritmo
  const expected = sign(`${head}.${body}`, secret);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  return payload;
}
