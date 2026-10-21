// Roda contra um Postgres descartável já com o esquema do Kobly aplicado.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { signJwt } from '../src/jwt.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const SECRET = 'segredo-de-teste-integracao';
let pool, server, base;

const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const uniq = () => `t${Date.now()}${Math.floor(Math.random() * 1e6)}@kobly.test`;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 5 });
  const config = { jwtSecret: SECRET, requireConfirm: false, allowedOrigins: ['https://app.exemplo.test'], trustProxy: false, loginPerMin: 1000, signupPerMin: 1000 };
  ({ server } = createApp({ pool, config }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (skip) return; await new Promise((r) => server.close(r)); await pool.end(); });

test('cadastro cria usuário, perfil Cliente (trigger) e já devolve sessão', { skip }, async () => {
  const email = uniq();
  const r = await post('/auth/signup', { email, password: 'senha-forte-123', nome: 'Pessoa Teste' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.session.access_token && j.session.refresh_token);
  const p = await pool.query(`select tipo_user_geral, nome, status_user from public.profiles where lower(email::text) = $1`, [email]);
  assert.deepEqual(p.rows[0], { tipo_user_geral: 'Cliente', nome: 'Pessoa Teste', status_user: 'Ativo' });
});

test('senha fraca e e-mail inválido são recusados', { skip }, async () => {
  assert.equal((await post('/auth/signup', { email: uniq(), password: '123' })).status, 422);
  assert.equal((await post('/auth/signup', { email: 'sem-arroba', password: 'senha-forte-123' })).status, 422);
});

test('login: certo entra; errado e inexistente dão a MESMA resposta', { skip }, async () => {
  const email = uniq();
  await post('/auth/signup', { email, password: 'senha-forte-123' });
  assert.equal((await post('/auth/login', { email, password: 'senha-forte-123' })).status, 200);
  const wrong = await post('/auth/login', { email, password: 'errada-errada' });
  const ghost = await post('/auth/login', { email: uniq(), password: 'errada-errada' });
  assert.equal(wrong.status, 400); assert.equal(ghost.status, 400);
  assert.deepEqual(await wrong.json(), await ghost.json());
});

test('5 falhas travam a conta (429) e a senha certa não destrava durante o bloqueio', { skip }, async () => {
  const email = uniq();
  await post('/auth/signup', { email, password: 'senha-forte-123' });
  for (let i = 0; i < 5; i++) assert.equal((await post('/auth/login', { email, password: 'errada-errada' })).status, 400);
  assert.equal((await post('/auth/login', { email, password: 'senha-forte-123' })).status, 429);
});

test('refresh é rotativo: o token antigo morre; logout invalida', { skip }, async () => {
  const email = uniq();
  const s1 = (await (await post('/auth/signup', { email, password: 'senha-forte-123' })).json()).session;
  const r2 = await post('/auth/refresh', { refresh_token: s1.refresh_token });
  assert.equal(r2.status, 200);
  const s2 = await r2.json();
  assert.equal((await post('/auth/refresh', { refresh_token: s1.refresh_token })).status, 401);
  assert.equal((await post('/auth/logout', { refresh_token: s2.refresh_token })).status, 200);
  assert.equal((await post('/auth/refresh', { refresh_token: s2.refresh_token })).status, 401);
});

test('/auth/user: token válido ok; adulterado, expirado e outro segredo recusados', { skip }, async () => {
  const email = uniq();
  const s = (await (await post('/auth/signup', { email, password: 'senha-forte-123' })).json()).session;
  const get = (t) => fetch(base + '/auth/user', { headers: t ? { authorization: `Bearer ${t}` } : {} });
  assert.equal((await get(s.access_token)).status, 200);
  assert.equal((await get(null)).status, 401);
  assert.equal((await get(s.access_token + 'x')).status, 401);
  const uid = JSON.parse(Buffer.from(s.access_token.split('.')[1], 'base64url')).sub;
  assert.equal((await get(signJwt({ sub: uid, exp: 10 }, SECRET))).status, 401);
  assert.equal((await get(signJwt({ sub: uid, exp: 2_000_000_000 }, 'outro'))).status, 401);
});

test('usuário Desabilitado pelo admin não entra', { skip }, async () => {
  const email = uniq();
  await post('/auth/signup', { email, password: 'senha-forte-123' });
  await pool.query(`update public.profiles set status_user = 'Desabilitado' where lower(email::text) = $1`, [email]);
  assert.equal((await post('/auth/login', { email, password: 'senha-forte-123' })).status, 400);
});

test('recuperação: token de uso único troca a senha e derruba sessões antigas', { skip }, async () => {
  const email = uniq();
  const s = (await (await post('/auth/signup', { email, password: 'senha-forte-123' })).json()).session;
  assert.equal((await post('/auth/recover', { email })).status, 200);
  assert.equal((await post('/auth/recover', { email: uniq() })).status, 200); // não revela se existe
  // o e-mail não é enviado neste teste: gera o token direto pelo serviço
  const { rows } = await pool.query(`select id from auth.users where lower(email) = $1`, [email]);
  const { auth } = createApp({ pool, config: { jwtSecret: SECRET } });
  const token = await auth.createOneTimeToken(rows[0].id, 'recovery', 3600);
  const rs = await post('/auth/reset', { token, password: 'nova-senha-456' });
  assert.equal(rs.status, 200);
  assert.ok((await rs.json()).access_token); // já volta logado
  assert.equal((await post('/auth/reset', { token, password: 'outra-senha-789' })).status, 400); // uso único
  assert.equal((await post('/auth/refresh', { refresh_token: s.refresh_token })).status, 401);
  assert.equal((await post('/auth/login', { email, password: 'senha-forte-123' })).status, 400);
  assert.equal((await post('/auth/login', { email, password: 'nova-senha-456' })).status, 200);
  assert.equal((await post('/auth/reset', { token: 'qualquer', password: 'curta' })).status, 422);
});

test('CORS só libera origens da lista', { skip }, async () => {
  const ok = await fetch(base + '/health', { headers: { origin: 'https://app.exemplo.test' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.exemplo.test');
  const bad = await fetch(base + '/health', { headers: { origin: 'https://evil.test' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('corpo grande e JSON inválido são recusados; rota inexistente 404', { skip }, async () => {
  const big = await fetch(base + '/auth/login', { method: 'POST', body: 'x'.repeat(100_000) }).catch(() => ({ status: 413 }));
  assert.ok([400, 413].includes(big.status));
  const bad = await fetch(base + '/auth/login', { method: 'POST', body: '{nao-json' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(base + '/nada')).status, 404);
});

test('limite por IP: depois do teto responde 429', { skip }, async () => {
  const config = { jwtSecret: SECRET, requireConfirm: false, allowedOrigins: [], trustProxy: false, loginPerMin: 3, signupPerMin: 3 };
  const { server: s2 } = createApp({ pool, config });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(b2 + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@y.test', password: 'qualquer-coisa' }) })).status);
  await new Promise((r) => s2.close(r));
  assert.deepEqual(codes, [400, 400, 400, 429, 429]);
});

test('proxy /rest/v1: repassa só cabeçalhos permitidos e devolve status/corpo do PostgREST', { skip }, async () => {
  const seen = [];
  const fakeFetch = async (url, init) => { seen.push({ url, init }); return new Response('[{"id":1}]', { status: 200, headers: { 'content-type': 'application/json', 'content-range': '0-0/1', 'set-cookie': 'x=1' } }); };
  const { server: s3 } = createApp({ pool, config: { jwtSecret: SECRET, allowedOrigins: [], postgrestUrl: 'http://pgrst.invalid:1' }, fetchImpl: fakeFetch });
  await new Promise((r) => s3.listen(0, '127.0.0.1', r));
  const b3 = `http://127.0.0.1:${s3.address().port}`;
  const r = await fetch(b3 + '/rest/v1/leads?select=id&organization_id=eq.1', { headers: { authorization: 'Bearer abc', prefer: 'count=exact', cookie: 'segredo=1', 'x-forwarded-for': '1.2.3.4' } });
  await new Promise((rr) => s3.close(rr));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-range'), '0-0/1');
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(seen[0].url, 'http://pgrst.invalid:1/leads?select=id&organization_id=eq.1');
  assert.equal(seen[0].init.headers.authorization, 'Bearer abc');
  assert.equal(seen[0].init.headers.cookie, undefined);
  assert.equal(seen[0].init.headers['x-forwarded-for'], undefined);
});

test('proxy sem PostgREST configurado dá 503; PostgREST fora do ar dá 502', { skip }, async () => {
  const mk = async (cfg, f) => { const { server: s } = createApp({ pool, config: { jwtSecret: SECRET, allowedOrigins: [], ...cfg }, fetchImpl: f }); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return s; };
  const a = await mk({}, undefined);
  assert.equal((await fetch(`http://127.0.0.1:${a.address().port}/rest/v1/leads`)).status, 503);
  await new Promise((r) => a.close(r));
  const b = await mk({ postgrestUrl: 'http://x.invalid' }, async () => { throw new Error('down'); });
  assert.equal((await fetch(`http://127.0.0.1:${b.address().port}/rest/v1/leads`)).status, 502);
  await new Promise((r) => b.close(r));
});

test('/functions/v1/<nome> ainda não portada responde 501 claro; GET dá 405', { skip }, async () => {
  const r = await post('/functions/v1/send-email', { to: 'a@b.test' });
  assert.equal(r.status, 501);
  assert.equal((await r.json()).code, 'not_ported');
  assert.equal((await fetch(base + '/functions/v1/send-email')).status, 405);
});

test('CORS libera PATCH/DELETE e cabeçalhos do cliente de dados', { skip }, async () => {
  const r = await fetch(base + '/rest/v1/leads', { method: 'OPTIONS', headers: { origin: 'https://app.exemplo.test' } });
  assert.equal(r.status, 204);
  assert.match(r.headers.get('access-control-allow-methods'), /PATCH/);
  assert.match(r.headers.get('access-control-allow-headers'), /prefer/);
});
