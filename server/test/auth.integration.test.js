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

// ---------------------------------------------------------------------------
// WhatsApp oficial (Meta): conta por empresa, segredos cifrados, webhook assinado
// ---------------------------------------------------------------------------
import { createHmac, randomBytes } from 'node:crypto';
import { decrypt } from '../src/whatsapp/crypto.js';

const WKEY = randomBytes(32);
// banco de teste descartável: começa sem contas de WhatsApp de execuções anteriores
before(async () => { if (!skip) { await pool.query('delete from public.whatsapp_accounts'); await pool.query('delete from public.scheduled_steps'); } });
function fakeGraph() {
  const g = { calls: [], templates: [], badToken: false };
  g.getPhoneNumber = async (pid, tok) => { g.calls.push(['phone', pid]); if (tok.startsWith('BAD')) { const { MetaError } = await import('../src/whatsapp/graph.js'); throw new MetaError(400, 190, 'expired'); } return { display_phone_number: '+55 11 98888-7777', verified_name: 'Loja Teste', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' }; };
  g.getWaba = async () => ({ id: 'w' });
  g.subscribeApp = async () => ({ success: true });
  g.listTemplates = async () => g.templates;
  g.createTemplate = async (w, t, req) => { g.calls.push(['create', req.name]); return { id: 'tpl-' + req.name, status: 'PENDING' }; };
  g.sendTemplate = async (pid, tok, p) => { g.calls.push(['send', pid, p.to, p.name]); return { messages: [{ id: 'wamid.' + g.calls.length }] }; };
  return g;
}
async function mkWaApp(g) {
  const config = { jwtSecret: SECRET, requireConfirm: false, allowedOrigins: [], trustProxy: false, loginPerMin: 1000, signupPerMin: 1000, secretKey: WKEY.toString('base64'), publicBaseUrl: 'https://api.test' };
  const { server: s } = createApp({ pool, config, graph: g });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, b: `http://127.0.0.1:${s.address().port}` };
}
async function newClient(b) {
  const email = uniq();
  const sess = (await (await fetch(b + '/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'senha-forte-123' }) })).json()).session;
  // empresa criada do jeito real: pela função do cadastro, como o próprio usuário
  const cl = await pool.connect();
  let orgId;
  try {
    await cl.query('begin'); await cl.query('set local role kobly_authenticated');
    await cl.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: sess.user.id, role: 'kobly_authenticated' })]);
    await cl.query(`select public.create_own_org($1)`, ['Empresa ' + email]);
    orgId = (await cl.query(`select organization_id from public.profiles where auth_id = auth.uid()`)).rows[0].organization_id;
    await cl.query('commit');
  } finally { cl.release(); }
  const org = { rows: [{ id: orgId }] };
  return { email, token: sess.access_token, orgId: org.rows[0].id, userId: sess.user.id };
}
const fn = (b, name, tok, body) => fetch(`${b}/functions/v1/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });

test('whatsapp: conectar valida na Meta, cifra o token e NÃO devolve segredo', { skip }, async () => {
  const g = fakeGraph(); const { s, b } = await mkWaApp(g);
  const c = await newClient(b);
  const r = await fn(b, 'whatsapp-account', c.token, { action: 'connect', waba_id: '123456789012345', phone_number_id: '109876543210987', access_token: 'EAAGsecretotokenmuitolongo123' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.account.status, 'connected'); assert.equal(j.account.display_phone, '+55 11 98888-7777');
  assert.match(j.account.webhook_url, /^https:\/\/api\.test\/webhooks\/whatsapp\/[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify(j).includes('EAAGsecreto'));
  const row = (await pool.query(`select token_enc from public.whatsapp_accounts where organization_id = $1`, [c.orgId])).rows[0];
  assert.ok(!row.token_enc.includes('EAAG')); assert.equal(decrypt(row.token_enc, WKEY), 'EAAGsecretotokenmuitolongo123');
  // o cliente (papel authenticated) não consegue ler o segredo direto no banco
  const cl = await pool.connect();
  try {
    await cl.query('begin'); await cl.query('set local role kobly_authenticated');
    await cl.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: c.userId, role: 'kobly_authenticated' })]);
    await assert.rejects(cl.query('select token_enc from public.whatsapp_accounts'), /permission denied/);
    await cl.query('rollback'); await cl.query('begin'); await cl.query('set local role kobly_authenticated');
    await cl.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: c.userId, role: 'kobly_authenticated' })]);
    assert.equal((await cl.query('select display_phone from public.whatsapp_accounts')).rowCount, 1);
    await assert.rejects(cl.query(`update public.whatsapp_accounts set status='x'`), /permission denied/);
    await cl.query('rollback');
  } finally { cl.release(); }
  await new Promise((rr) => s.close(rr));
});

test('whatsapp: token inválido na Meta, número já usado em outra empresa e entradas ruins', { skip }, async () => {
  const g = fakeGraph(); const { s, b } = await mkWaApp(g);
  const c1 = await newClient(b); const c2 = await newClient(b);
  const bad = await fn(b, 'whatsapp-account', c1.token, { action: 'connect', waba_id: '123456789012345', phone_number_id: '109876543210111', access_token: 'BADtokenbadtokenbadtoken1' });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).code, 'meta_token_invalid');
  assert.equal((await fn(b, 'whatsapp-account', c1.token, { action: 'connect', waba_id: 'abc', phone_number_id: '1', access_token: 'x' })).status, 422);
  const body = { action: 'connect', waba_id: '123456789012345', phone_number_id: '109876543210222', access_token: 'EAAGoutrotokenlongolongo12' };
  assert.equal((await fn(b, 'whatsapp-account', c1.token, body)).status, 200);
  const dup = await fn(b, 'whatsapp-account', c2.token, body);
  assert.equal(dup.status, 409); assert.equal((await dup.json()).code, 'phone_in_use');
  assert.equal((await fn(b, 'whatsapp-account', '', { action: 'status' })).status, 401);
  assert.equal((await fn(b, 'whatsapp-account', c1.token, { action: 'zzz' })).status, 400);
  await new Promise((rr) => s.close(rr));
});

test('whatsapp: uma empresa não enxerga nem mexe na conta de outra', { skip }, async () => {
  const g = fakeGraph(); const { s, b } = await mkWaApp(g);
  const c1 = await newClient(b); const c2 = await newClient(b);
  await fn(b, 'whatsapp-account', c1.token, { action: 'connect', waba_id: '123456789012345', phone_number_id: '109876543210333', access_token: 'EAAGtokenumlongolongolong12' });
  const mine = await (await fn(b, 'whatsapp-account', c2.token, { action: 'status' })).json();
  assert.equal(mine.connected, false);
  const peek = await fn(b, 'whatsapp-account', c2.token, { action: 'status', org_id: c1.orgId });
  assert.equal(peek.status, 403);
  const hack = await fn(b, 'whatsapp-account', c2.token, { action: 'disconnect', org_id: c1.orgId });
  assert.equal(hack.status, 403);
  assert.equal((await pool.query(`select 1 from public.whatsapp_accounts where organization_id = $1`, [c1.orgId])).rowCount, 1);
  await new Promise((rr) => s.close(rr));
});

test('whatsapp: modelos — sincroniza, cria, e só envia aprovado com variáveis', { skip }, async () => {
  const g = fakeGraph(); const { s, b } = await mkWaApp(g);
  const c = await newClient(b);
  await fn(b, 'whatsapp-account', c.token, { action: 'connect', waba_id: '123456789012345', phone_number_id: '109876543210444', access_token: 'EAAGtokendoistokenlongo123' });
  g.templates = [
    { id: 'm1', name: 'carrinho', language: 'pt_BR', category: 'MARKETING', status: 'APPROVED', components: [{ type: 'BODY', text: 'Oi {{1}}, volte para {{2}}' }] },
    { id: 'm2', name: 'rejeitado', language: 'pt_BR', category: 'MARKETING', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', components: [{ type: 'BODY', text: 'x' }] },
  ];
  assert.equal((await (await fn(b, 'whatsapp-account', c.token, { action: 'sync_templates' })).json()).synced, 2);
  const tpls = (await pool.query(`select id, name, status, variable_count from public.whatsapp_templates where organization_id = $1 order by name`, [c.orgId])).rows;
  assert.deepEqual(tpls.map((t) => [t.name, t.status, t.variable_count]), [['carrinho', 'APPROVED', 2], ['rejeitado', 'REJECTED', 0]]);
  const ok = tpls[0].id; const rej = tpls[1].id;
  const sent = await fn(b, 'whatsapp-account', c.token, { action: 'send_test', to: '(11) 98888-7777', template_id: ok, variables: ['Ana', 'sua compra'] });
  assert.equal(sent.status, 200); assert.ok((await sent.json()).id.startsWith('wamid.'));
  assert.deepEqual(g.calls.at(-1), ['send', '109876543210444', '5511988887777', 'carrinho']);
  assert.equal((await fn(b, 'whatsapp-account', c.token, { action: 'send_test', to: '11988887777', template_id: rej, variables: [] })).status, 409);
  assert.equal((await fn(b, 'whatsapp-account', c.token, { action: 'send_test', to: '11988887777', template_id: ok, variables: ['só um'] })).status, 422);
  assert.equal((await fn(b, 'whatsapp-account', c.token, { action: 'send_test', to: '12', template_id: ok, variables: ['a', 'b'] })).status, 422);
  const created = await fn(b, 'whatsapp-account', c.token, { action: 'create_template', name: 'novo_modelo', body: 'Olá {{1}}', examples: ['Ana'] });
  assert.equal(created.status, 200);
  assert.equal((await pool.query(`select status from public.whatsapp_templates where name = 'novo_modelo' and organization_id = $1`, [c.orgId])).rows[0].status, 'PENDING');
  assert.equal((await fn(b, 'whatsapp-account', c.token, { action: 'create_template', name: 'Inválido!', body: 'x' })).status, 422);
  await new Promise((rr) => s.close(rr));
});

test('whatsapp: webhook — verificação, assinatura, status de entrega, modelo aprovado e opt-out', { skip }, async () => {
  const U = randomBytes(4).toString('hex'); // o id da Meta é único no mundo; no teste, um por execução
  const g = fakeGraph(); const { s, b } = await mkWaApp(g);
  const c = await newClient(b);
  const conn = await (await fn(b, 'whatsapp-account', c.token, { action: 'connect', waba_id: '123456789012345', phone_number_id: '109876543210555', access_token: 'EAAGtokentrestokenlongo1234', app_secret: 'segredo-do-app-meta' })).json();
  const pubId = conn.account.webhook_url.split('/').pop(); const vt = conn.account.verify_token;
  // verificação (GET)
  assert.equal(await (await fetch(`${b}/webhooks/whatsapp/${pubId}?hub.mode=subscribe&hub.verify_token=${vt}&hub.challenge=12345`)).text(), '12345');
  assert.equal((await fetch(`${b}/webhooks/whatsapp/${pubId}?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1`)).status, 403);
  assert.equal((await fetch(`${b}/webhooks/whatsapp/00000000-0000-0000-0000-000000000000?hub.mode=subscribe&hub.verify_token=${vt}&hub.challenge=1`)).status, 403);
  // dados de apoio: um lead, um envio registrado e um modelo
  await pool.query(`insert into public.leads (organization_id, nome, telefone) values ($1,'Ana','(11) 98888-7777')`, [c.orgId]);
  await pool.query(`insert into public.email_events (organization_id, event, channel, status, email, sg_message_id) values ($1,'send','whatsapp','enviado','ana@x.test',$2)`, [c.orgId, `wamid.AAA${U}`]);
  g.templates = [{ id: 'mt9', name: 'promo', language: 'pt_BR', category: 'MARKETING', status: 'PENDING', components: [{ type: 'BODY', text: 'oi' }] }];
  await fn(b, 'whatsapp-account', c.token, { action: 'sync_templates' });
  const payload = { object: 'whatsapp_business_account', entry: [{ id: '123', changes: [
    { field: 'messages', value: { metadata: { phone_number_id: '109876543210555' }, statuses: [{ id: `wamid.AAA${U}`, status: 'delivered' }, { id: `wamid.AAA${U}`, status: 'read' }, { id: `wamid.ZZZ${U}`, status: 'delivered' }],
      messages: [{ from: '5511988887777', type: 'text', text: { body: 'SAIR' } }, { from: '5511900000000', type: 'text', text: { body: 'quero comprar' } }] } },
    { field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: 'mt9', message_template_name: 'promo' } },
  ] }] };
  const raw = JSON.stringify(payload);
  const sign = (body, secret) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  const post = (body, sig) => fetch(`${b}/webhooks/whatsapp/${pubId}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'x-hub-signature-256': sig } : {}) }, body });
  assert.equal((await post(raw, null)).status, 403);                                  // sem assinatura
  assert.equal((await post(raw, sign(raw, 'outro-segredo'))).status, 403);            // assinatura de outro segredo
  assert.equal((await post(raw + ' ', sign(raw, 'segredo-do-app-meta'))).status, 403); // corpo adulterado
  const first = await post(raw, sign(raw, 'segredo-do-app-meta'));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, statuses: 2, templates: 1, optOuts: 1 });
  assert.equal((await post(raw, sign(raw, 'segredo-do-app-meta'))).status, 200);      // reentrega não duplica
  const ev = (await pool.query(`select status from public.email_events where organization_id = $1 and event = 'status' and channel = 'whatsapp' order by status`, [c.orgId])).rows.map((r) => r.status);
  assert.deepEqual(ev, ['entregue', 'lido']);
  assert.equal((await pool.query(`select status from public.whatsapp_templates where organization_id = $1 and name = 'promo'`, [c.orgId])).rows[0].status, 'APPROVED');
  assert.equal((await pool.query(`select whatsapp_opt_out from public.leads where organization_id = $1`, [c.orgId])).rows[0].whatsapp_opt_out, true);
  await new Promise((rr) => s.close(rr));
});

test('whatsapp: webhook de outra empresa não altera dados desta', { skip }, async () => {
  const g = fakeGraph(); const { s, b } = await mkWaApp(g);
  const a = await newClient(b); const o = await newClient(b);
  const ca = await (await fn(b, 'whatsapp-account', a.token, { action: 'connect', waba_id: '123456789012345', phone_number_id: '109876543210666', access_token: 'EAAGtokenAAAAlongolongo123', app_secret: 'sa' })).json();
  await fn(b, 'whatsapp-account', o.token, { action: 'connect', waba_id: '123456789012345', phone_number_id: '109876543210777', access_token: 'EAAGtokenBBBBlongolongo123', app_secret: 'sb' });
  await pool.query(`insert into public.email_events (organization_id, event, channel, status, email, sg_message_id) values ($1,'send','whatsapp','enviado','o@x.test','wamid.OUTRA')`, [o.orgId]);
  const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '109876543210666' }, statuses: [{ id: 'wamid.OUTRA', status: 'read' }] } }] }] });
  const sig = 'sha256=' + createHmac('sha256', 'sa').update(raw).digest('hex');
  assert.equal((await fetch(ca.account.webhook_url.replace('https://api.test', b), { method: 'POST', headers: { 'x-hub-signature-256': sig }, body: raw })).status, 200);
  assert.equal((await pool.query(`select count(*)::int n from public.email_events where organization_id = $1 and event = 'status'`, [o.orgId])).rows[0].n, 0);
  await new Promise((rr) => s.close(rr));
});

test('whatsapp: modelo de outra empresa não é enviado; Suporte não altera a conexão', { skip }, async () => {
  const g = fakeGraph(); const { s, b } = await mkWaApp(g);
  const c1 = await newClient(b); const c2 = await newClient(b);
  for (const [c, pid] of [[c1, '109876543210881'], [c2, '109876543210882']]) {
    await fn(b, 'whatsapp-account', c.token, { action: 'connect', waba_id: '123456789012345', phone_number_id: pid, access_token: 'EAAGtokenparateste12345678' });
  }
  g.templates = [{ id: 'x1', name: 'so_da_c1', language: 'pt_BR', category: 'MARKETING', status: 'APPROVED', components: [{ type: 'BODY', text: 'oi' }] }];
  await fn(b, 'whatsapp-account', c1.token, { action: 'sync_templates' });
  const tplC1 = (await pool.query(`select id from public.whatsapp_templates where organization_id = $1`, [c1.orgId])).rows[0].id;
  const stolen = await fn(b, 'whatsapp-account', c2.token, { action: 'send_test', to: '11988887777', template_id: tplC1, variables: [] });
  assert.equal(stolen.status, 404);
  assert.ok(!g.calls.some((x) => x[0] === 'send' && x[1] === '109876543210882'));
  // perfil Suporte: vê a empresa mas não mexe na conexão
  const sup = await newClient(b);
  const adm = await pool.connect();
  try {
    await adm.query('begin'); await adm.query(`set local session_replication_role = replica`); // o gatilho de proteção do perfil não vale p/ o preparo do teste
    await adm.query(`update public.profiles set tipo_user_geral = 'Suporte' where auth_id = $1`, [sup.userId]);
    await adm.query(`insert into public.organization_memberships (organization_id, profile_id, role) select $1, id, 'Suporte' from public.profiles where auth_id = $2`, [c1.orgId, sup.userId]);
    await adm.query('commit');
  } finally { adm.release(); }
  assert.equal((await pool.query(`select tipo_user_geral from public.profiles where auth_id = $1`, [sup.userId])).rows[0].tipo_user_geral, 'Suporte');
  // sanidade: Suporte enxerga a empresa (a recusa abaixo vem da regra de perfil, não de falta de acesso)
  assert.equal((await fn(b, 'whatsapp-account', sup.token, { action: 'status', org_id: c1.orgId })).status, 200);
  const r = await fn(b, 'whatsapp-account', sup.token, { action: 'connect', org_id: c1.orgId, waba_id: '123456789012345', phone_number_id: '109876543210883', access_token: 'EAAGtokensuporte123456789' });
  assert.equal(r.status, 403);
  assert.equal((await fn(b, 'whatsapp-account', sup.token, { action: 'disconnect', org_id: c1.orgId })).status, 403);
  assert.equal((await pool.query(`select count(*)::int n from public.whatsapp_accounts where organization_id = $1`, [c1.orgId])).rows[0].n, 1);
  await new Promise((rr) => s.close(rr));
});

test('whatsapp: webhook só aceita avisos do próprio número e das próprias mensagens', { skip }, async () => {
  const g = fakeGraph(); const { s, b } = await mkWaApp(g);
  const a = await newClient(b); const o = await newClient(b);
  const U = randomBytes(4).toString('hex');
  const ca = await (await fn(b, 'whatsapp-account', a.token, { action: 'connect', waba_id: '123456789012345', phone_number_id: '109876543210991', access_token: 'EAAGtokenAAAAlongolongo123', app_secret: 'sa' })).json();
  await fn(b, 'whatsapp-account', o.token, { action: 'connect', waba_id: '123456789012345', phone_number_id: '109876543210992', access_token: 'EAAGtokenBBBBlongolongo123', app_secret: 'sb' });
  await pool.query(`insert into public.email_events (organization_id, event, channel, status, email, sg_message_id) values ($1,'send','whatsapp','enviado','o@x.test',$2), ($3,'send','whatsapp','enviado','a@x.test',$4)`, [o.orgId, `wamid.O${U}`, a.orgId, `wamid.A${U}`]);
  const hit = async (phoneId, id) => {
    const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneId }, statuses: [{ id, status: 'read' }] } }] }] });
    const sig = 'sha256=' + createHmac('sha256', 'sa').update(raw).digest('hex');
    return (await fetch(ca.account.webhook_url.replace('https://api.test', b), { method: 'POST', headers: { 'x-hub-signature-256': sig }, body: raw })).json();
  };
  assert.equal((await hit('109876543210991', `wamid.O${U}`)).statuses, 0);   // id é da outra empresa
  assert.equal((await hit('109876543210992', `wamid.A${U}`)).statuses, 0);   // aviso de outro número
  assert.equal((await hit('109876543210991', `wamid.A${U}`)).statuses, 1);   // o certo
  assert.equal((await pool.query(`select count(*)::int n from public.email_events where organization_id = $1 and event = 'status'`, [o.orgId])).rows[0].n, 0);
  await new Promise((rr) => s.close(rr));
});

// ---- Entrada de vendas + motor de disparos (WhatsApp) -------------------------------------
async function mkCampaign(c, { tipoEvento = 'Pix Gerado', vars = ['nome', 'produto'], atraso = 0, condicao = null } = {}) {
  const q = (t, p) => pool.query(t, p);
  const camp = (await q(`insert into public.campaigns (organization_id, nome, status_campanha) values ($1,'Teste','Ativa') returning id`, [c.orgId])).rows[0];
  const flow = (await q(`insert into public.campaign_flows (campaign_id, organization_id) values ($1,$2) returning id`, [camp.id, c.orgId])).rows[0];
  const tpl = (await q(`select id from public.whatsapp_templates where organization_id = $1 and name = 'recuperar'`, [c.orgId])).rows[0];
  const wm = (await q(`insert into public.whatsapp_messages (organization_id, titulo, template_id, template_vars) values ($1,'m',$2,$3) returning id`, [c.orgId, tpl.id, JSON.stringify(vars)])).rows[0];
  await q(`insert into public.flow_steps (flow_id, organization_id, tipo_card, posicao, tipo_evento) values ($1,$2,'Gatilho',0,$3)`, [flow.id, c.orgId, tipoEvento]);
  const st = (await q(`insert into public.flow_steps (flow_id, organization_id, tipo_card, posicao, atraso, whatsapp_message_id, condicao) values ($1,$2,'Envio de WhatsApp',1,$3,$4,$5) returning id`, [flow.id, c.orgId, atraso, wm.id, condicao])).rows[0];
  const tok = (await q(`insert into public.postback_tokens (organization_id, nome) values ($1,'t') returning token`, [c.orgId])).rows[0].token;
  return { campId: camp.id, stepId: st.id, token: tok };
}
async function mkConnected(b, g, c, pid) {
  await fn(b, 'whatsapp-account', c.token, { action: 'connect', waba_id: '123456789012345', phone_number_id: pid, access_token: 'EAAGtokenparateste12345678' });
  g.templates = [{ id: 'r1', name: 'recuperar', language: 'pt_BR', category: 'MARKETING', status: 'APPROVED', components: [{ type: 'BODY', text: 'Oi {{1}}, voltou {{2}}?' }] }];
  await fn(b, 'whatsapp-account', c.token, { action: 'sync_templates' });
}
const pb = (b, token, body) => fetch(`${b}/functions/v1/postback-receiver?token=${token}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
const mkEngine = (g) => createApp({ pool, config: { jwtSecret: SECRET, requireConfirm: false, allowedOrigins: [], trustProxy: false, loginPerMin: 1000, signupPerMin: 1000, secretKey: WKEY.toString('base64'), publicBaseUrl: 'https://api.test' }, graph: g }).engine;

test('postback: token inválido 401; JSON ruim 400; evento desconhecido 200 + dead-letter', { skip }, async () => {
  const g = fakeGraph(); const { s, b } = await mkWaApp(g); const c = await newClient(b); await mkConnected(b, g, c, '109876543210771');
  const k = await mkCampaign(c);
  assert.equal((await pb(b, 'pbk_nao_existe', { event: 'pix_generated', email: 'a@x.test' })).status, 401);
  assert.equal((await pb(b, k.token, '{nao json')).status, 400);
  const r = await pb(b, k.token, { event: 'evento_estranho', email: 'a@x.test' });
  assert.equal(r.status, 200); assert.equal((await r.json()).reason, 'unknown_event_or_missing_email');
  assert.equal((await pool.query(`select count(*)::int n from public.webhook_dead_letter where organization_id = $1`, [c.orgId])).rows[0].n, 1);
  await new Promise((rr) => s.close(rr));
});

test('postback → fila → envio de WhatsApp por modelo; reentrega não duplica; SAIR bloqueia', { skip }, async () => {
  const g = fakeGraph(); const { s, b } = await mkWaApp(g); const eng = mkEngine(g);
  const c = await newClient(b); await mkConnected(b, g, c, '109876543210772');
  const k = await mkCampaign(c);
  const U = randomBytes(3).toString('hex'); const mail = `lead${U}@x.test`;
  const body = { event: 'pix_generated', email: mail, name: 'Ana', phone: '11988887777', product: 'Tênis', value: 99.9, external_id: 'T' + U, metadata: { checkout_url: 'https://loja.test/c/1' } };
  const r1 = await (await pb(b, k.token, body)).json();
  assert.equal(r1.enqueued, 1); assert.deepEqual(r1.campanhas_acionadas, [k.campId]);
  assert.equal((await (await pb(b, k.token, body)).json()).deduped, true);           // reentrega
  assert.equal((await pool.query(`select count(*)::int n from public.scheduled_steps where organization_id = $1`, [c.orgId])).rows[0].n, 1);
  const t1 = await eng.tick();
  assert.equal(t1.sent, 1);
  const sent = g.calls.filter((x) => x[0] === 'send');
  assert.equal(sent.length, 1); assert.equal(sent[0][1], '109876543210772'); assert.equal(sent[0][2], '5511988887777'); assert.equal(sent[0][3], 'recuperar');
  assert.equal((await pool.query(`select status_agendamento st from public.scheduled_steps where organization_id = $1`, [c.orgId])).rows[0].st, 'Finalizado');
  assert.equal((await pool.query(`select count(*)::int n from public.email_events where organization_id = $1 and channel = 'whatsapp' and status = 'enviado'`, [c.orgId])).rows[0].n, 1);
  assert.equal((await pool.query(`select whatsapp_enviados n from public.campaign_stats where campaign_id = $1`, [k.campId])).rows[0].n, 1);
  assert.equal((await eng.tick()).claimed, 0);                                          // nada novo: não reenvia
  // SAIR: novo evento do mesmo lead não gera envio
  await pool.query(`update public.leads set whatsapp_opt_out = true where organization_id = $1 and email = $2`, [c.orgId, mail]);
  await pb(b, k.token, { ...body, external_id: 'T2' + U });
  const t2 = await eng.tick();
  assert.equal(t2.skipped, 1); assert.equal(g.calls.filter((x) => x[0] === 'send').length, 1);
  await new Promise((rr) => s.close(rr));
});

test('motor: falha transitória reagenda com backoff e desiste na 4ª; falha definitiva não repete; condição "comprou"', { skip }, async () => {
  const g = fakeGraph(); const { s, b } = await mkWaApp(g); const eng = mkEngine(g);
  const c = await newClient(b); await mkConnected(b, g, c, '109876543210773');
  const k = await mkCampaign(c, { vars: ['nome', 'produto'], condicao: 'nao_comprou' });
  const U = randomBytes(3).toString('hex');
  const { MetaError } = await import('../src/whatsapp/graph.js');
  const orig = g.sendTemplate; g.sendTemplate = async () => { throw new MetaError(503, 1, 'indisponível'); };
  await pb(b, k.token, { event: 'pix_generated', email: `a${U}@x.test`, name: 'A', phone: '11977776666', product: 'P', external_id: 'A' + U });
  const q = () => pool.query(`select status_agendamento st, attempts, last_error, run_at > now() fut from public.scheduled_steps where organization_id = $1`, [c.orgId]).then((r) => r.rows[0]);
  for (let i = 1; i <= 4; i++) {
    const t = await eng.tick(); assert.equal(t.claimed, 1, `tentativa ${i}`);
    const row = await q();
    if (i < 4) { assert.equal(row.st, 'Em andamento'); assert.equal(row.attempts, i); assert.ok(row.fut); await pool.query(`update public.scheduled_steps set run_at = now() - interval '1 second' where organization_id = $1`, [c.orgId]); }
    else { assert.equal(row.st, 'Finalizado'); assert.equal(row.attempts, 4); assert.match(row.last_error, /indispon/); }
  }
  assert.equal((await eng.tick()).claimed, 0);
  // definitiva (número inválido pela Meta, 400): não retenta
  g.sendTemplate = async () => { throw new MetaError(400, 131026, 'Message undeliverable'); };
  await pb(b, k.token, { event: 'pix_generated', email: `b${U}@x.test`, name: 'B', phone: '11966665555', product: 'P', external_id: 'B' + U });
  const t = await eng.tick(); assert.equal(t.failed, 1);
  assert.equal((await pool.query(`select count(*)::int n from public.scheduled_steps where organization_id = $1 and status_agendamento = 'Finalizado' and attempts = 1`, [c.orgId])).rows[0].n, 1);
  // condição nao_comprou: lead que comprou no meio da cadência não recebe
  g.sendTemplate = orig;
  await pb(b, k.token, { event: 'pix_generated', email: `c${U}@x.test`, name: 'C', phone: '11955554444', product: 'P', external_id: 'C' + U });
  await pb(b, k.token, { event: 'payment_approved', email: `c${U}@x.test`, name: 'C', external_id: 'C2' + U });
  const t3 = await eng.tick(); assert.equal(t3.skipped, 1);
  assert.ok(!g.calls.some((x) => x[0] === 'send' && x[2] === '5511955554444'));
  await new Promise((rr) => s.close(rr));
});

test('motor: empresas isoladas — passo de uma empresa usa só o número e o modelo dela; lead de outra empresa não é afetado', { skip }, async () => {
  const g = fakeGraph(); const { s, b } = await mkWaApp(g); const eng = mkEngine(g);
  const a = await newClient(b); const o = await newClient(b);
  await mkConnected(b, g, a, '109876543210981'); await mkConnected(b, g, o, '109876543210982');
  const ka = await mkCampaign(a); const ko = await mkCampaign(o);
  const U = randomBytes(3).toString('hex');
  await pb(b, ka.token, { event: 'pix_generated', email: `x${U}@x.test`, name: 'X', phone: '11911112222', product: 'P', external_id: 'X' + U });
  await pb(b, ko.token, { event: 'pix_generated', email: `x${U}@x.test`, name: 'Y', phone: '11933334444', product: 'Q', external_id: 'Y' + U });   // mesmo e-mail, outra empresa
  assert.equal((await eng.tick()).sent, 2);
  const sends = g.calls.filter((x) => x[0] === 'send');
  assert.ok(sends.some((x) => x[1] === '109876543210981' && x[2] === '5511911112222'));
  assert.ok(sends.some((x) => x[1] === '109876543210982' && x[2] === '5511933334444'));
  assert.ok(!sends.some((x) => x[1] === '109876543210981' && x[2] === '5511933334444'));
  assert.equal((await pool.query(`select count(*)::int n from public.leads where email = $1`, [`x${U}@x.test`])).rows[0].n, 2);
  await new Promise((rr) => s.close(rr));
});

test('entrada/motor: token inativo, campanha em rascunho, mesma transação em duas empresas, reentrega sem ruído', { skip }, async () => {
  const g = fakeGraph(); const { s, b } = await mkWaApp(g);
  const a = await newClient(b); const o = await newClient(b);
  await mkConnected(b, g, a, '109876543210961'); await mkConnected(b, g, o, '109876543210962');
  const ka = await mkCampaign(a); const ko = await mkCampaign(o);
  const U = randomBytes(3).toString('hex');
  const ev = (mail) => ({ event: 'pix_generated', email: mail, name: 'N', phone: '11922223333', product: 'P', external_id: 'SAME' + U });
  // a mesma transação chegando em duas empresas deve valer nas duas
  assert.equal((await (await pb(b, ka.token, ev(`m${U}@x.test`))).json()).enqueued, 1);
  assert.equal((await (await pb(b, ko.token, ev(`m${U}@x.test`))).json()).enqueued, 1);
  // reentrega: 200 deduped e SEM linha de dead-letter
  assert.equal((await (await pb(b, ka.token, ev(`m${U}@x.test`))).json()).deduped, true);
  assert.equal((await pool.query(`select count(*)::int n from public.webhook_dead_letter where organization_id = $1`, [a.orgId])).rows[0].n, 0);
  // token desativado deixa de valer
  await pool.query(`update public.postback_tokens set ativo = false where token = $1`, [ka.token]);
  assert.equal((await pb(b, ka.token, ev(`n${U}@x.test`))).status, 401);
  // campanha em rascunho não dispara
  await pool.query(`update public.campaigns set status_campanha = 'Rascunho' where id = $1`, [ko.campId]);
  const r = await (await pb(b, ko.token, { ...ev(`p${U}@x.test`), external_id: 'R' + U })).json();
  assert.equal(r.enqueued, 0); assert.equal(r.motivo_sem_agendamento, 'nenhuma_campanha_ativa_para_este_token');
  await new Promise((rr) => s.close(rr));
});

test('motor: modelo de outra empresa e lead sem telefone não enviam; dois motores ao mesmo tempo não duplicam', { skip }, async () => {
  const g = fakeGraph(); const { s, b } = await mkWaApp(g); const e1 = mkEngine(g), e2 = mkEngine(g), e3 = mkEngine(g);
  const a = await newClient(b); const o = await newClient(b);
  await mkConnected(b, g, a, '109876543210951'); await mkConnected(b, g, o, '109876543210952');
  const ka = await mkCampaign(a);
  const U = randomBytes(3).toString('hex');
  await pool.query('delete from public.scheduled_steps');
  // modelo de OUTRA empresa ligado à mensagem da empresa A
  const tplO = (await pool.query(`select id from public.whatsapp_templates where organization_id = $1`, [o.orgId])).rows[0].id;
  await pool.query(`update public.whatsapp_messages set template_id = $2 where organization_id = $1`, [a.orgId, tplO]);
  await pb(b, ka.token, { event: 'pix_generated', email: `t${U}@x.test`, name: 'T', phone: '11944445555', product: 'P', external_id: 'TT' + U });
  await e1.tick();
  assert.ok(!g.calls.some((x) => x[0] === 'send'));
  assert.match((await pool.query(`select last_error from public.scheduled_steps where organization_id = $1`, [a.orgId])).rows[0].last_error, /modelo/i);
  // lead sem telefone
  await pool.query(`update public.whatsapp_messages set template_id = (select id from public.whatsapp_templates where organization_id = $1) where organization_id = $1`, [a.orgId]);
  await pb(b, ka.token, { event: 'pix_generated', email: `u${U}@x.test`, name: 'U', product: 'P', external_id: 'UU' + U });
  await e1.tick();
  assert.ok(!g.calls.some((x) => x[0] === 'send'));
  assert.equal((await pool.query(`select count(*)::int n from public.scheduled_steps where organization_id = $1 and last_error = 'lead sem telefone'`, [a.orgId])).rows[0].n, 1);
  // 30 leads, 3 motores em paralelo: cada lead recebe exatamente 1 mensagem
  for (let i = 0; i < 30; i++) await pb(b, ka.token, { event: 'pix_generated', email: `c${i}${U}@x.test`, name: 'C', phone: `119000${String(i).padStart(2, '0')}00${i % 10}`, product: 'P', external_id: `CC${i}${U}` });
  const rs = await Promise.all([e1.tick(), e2.tick(), e3.tick()]);
  assert.equal(rs.reduce((n, x) => n + x.sent, 0), 30);
  const dest = g.calls.filter((x) => x[0] === 'send').map((x) => x[2]);
  assert.equal(dest.length, 30); assert.equal(new Set(dest).size, 30);
  await new Promise((rr) => s.close(rr));
});
