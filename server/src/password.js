// Hash de senha: PBKDF2-SHA256 com 100.000 iterações (teto do Cloudflare Workers, para
// o mesmo código rodar lá no futuro). Formato: pbkdf2$<iter>$<salt b64url>$<hash b64url>.
import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2p = promisify(pbkdf2);
export const ITERATIONS = 100_000;
const KEYLEN = 32;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const dk = await pbkdf2p(String(password), salt, ITERATIONS, KEYLEN, 'sha256');
  return `pbkdf2$${ITERATIONS}$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}

// Hash "de mentira" para gastar o mesmo tempo quando o e-mail não existe.
let dummy;
export async function dummyHash() { return (dummy ||= hashPassword('nao-existe-esta-senha')); }

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, iterStr, saltB64, hashB64] = stored.split('$');
  const iter = Number(iterStr);
  // só aceita o esquema e o número de iterações que nós geramos
  if (scheme !== 'pbkdf2' || iter !== ITERATIONS || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  if (expected.length !== KEYLEN) return false;
  const dk = await pbkdf2p(String(password), Buffer.from(saltB64, 'base64url'), iter, KEYLEN, 'sha256');
  return timingSafeEqual(dk, expected);
}
