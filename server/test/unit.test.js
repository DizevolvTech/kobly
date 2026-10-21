import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword, ITERATIONS } from '../src/password.js';
import { signJwt, verifyJwt } from '../src/jwt.js';
import { createLimiter } from '../src/ratelimit.js';

test('senha: hash confere com a senha certa e rejeita a errada', async () => {
  const h = await hashPassword('senha-correta-123');
  assert.ok(h.startsWith(`pbkdf2$${ITERATIONS}$`));
  assert.equal(await verifyPassword('senha-correta-123', h), true);
  assert.equal(await verifyPassword('senha-errada-123', h), false);
});
test('senha: recusa esquema desconhecido, iterações diferentes e lixo', async () => {
  const h = await hashPassword('abc12345');
  assert.equal(await verifyPassword('abc12345', h.replace(`$${ITERATIONS}$`, '$999999$')), false);
  assert.equal(await verifyPassword('abc12345', h.replace('pbkdf2', 'md5')), false);
  assert.equal(await verifyPassword('abc12345', 'lixo'), false);
  assert.equal(await verifyPassword('abc12345', null), false);
});
test('senha: dois hashes da mesma senha são diferentes (salt)', async () => {
  assert.notEqual(await hashPassword('mesma-senha-1'), await hashPassword('mesma-senha-1'));
});

const S = 'segredo-de-teste';
test('jwt: assina e valida', () => {
  const t = signJwt({ sub: 'u1', exp: 2_000_000_000 }, S);
  assert.equal(verifyJwt(t, S, 1_000_000_000).sub, 'u1');
});
test('jwt: recusa expirado, segredo errado, adulterado e alg none', () => {
  const t = signJwt({ sub: 'u1', exp: 1_000 }, S);
  assert.equal(verifyJwt(t, S, 2_000), null);
  const ok = signJwt({ sub: 'u1', exp: 2_000_000_000 }, S);
  assert.equal(verifyJwt(ok, 'outro-segredo', 1_000_000_000), null);
  const [h, b, s] = ok.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: 2_000_000_000 })).toString('base64url');
  assert.equal(verifyJwt(`${h}.${forged}.${s}`, S, 1_000_000_000), null);
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${b}.`;
  assert.equal(verifyJwt(none, S, 1_000_000_000), null);
  // alg HS512 assinado com o mesmo segredo também é recusado
  const h512 = Buffer.from('{"alg":"HS512","typ":"JWT"}').toString('base64url');
  const sig = createHmac('sha512', S).update(`${h512}.${b}`).digest('base64url');
  assert.equal(verifyJwt(`${h512}.${b}.${sig}`, S, 1_000_000_000), null);
  assert.equal(verifyJwt('a.b', S), null);
  assert.equal(verifyJwt(undefined, S), null);
});
test('jwt: sem exp é recusado', () => {
  assert.equal(verifyJwt(signJwt({ sub: 'u1' }, S), S), null);
});
test('limitador: bloqueia depois do máximo e libera após a janela', () => {
  const allow = createLimiter({ max: 3, windowMs: 1000 });
  assert.deepEqual([allow('ip', 0), allow('ip', 1), allow('ip', 2), allow('ip', 3)], [true, true, true, false]);
  assert.equal(allow('outro', 3), true);
  assert.equal(allow('ip', 1500), true);
});

test('senha: hash CORRETO mas com outro número de iterações é recusado', async () => {
  const salt = randomBytes(16);
  const dk = pbkdf2Sync('senha-boa-123', salt, 150_000, 32, 'sha256');
  const stored = `pbkdf2$150000$${salt.toString('base64url')}$${dk.toString('base64url')}`;
  assert.equal(await verifyPassword('senha-boa-123', stored), false);
});
test('jwt: cabeçalho com outro alg, mesmo com assinatura HS256 válida, é recusado', () => {
  const head = Buffer.from('{"alg":"HS512","typ":"JWT"}').toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: 'u1', exp: 2_000_000_000 })).toString('base64url');
  const sig = createHmac('sha256', S).update(`${head}.${body}`).digest('base64url');
  assert.equal(verifyJwt(`${head}.${body}.${sig}`, S, 1_000_000_000), null);
});
