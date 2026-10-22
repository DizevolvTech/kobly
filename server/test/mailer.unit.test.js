import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailer, renderEmail } from '../src/mailer.js';

const quiet = { warn() {}, error() {} };
test('sem chave do provedor nada é enviado e o motivo é claro', async () => {
  const m = createMailer({ siteUrl: 'https://app.kobly.test', fetchImpl: async () => { throw new Error('não deveria chamar'); }, log: quiet });
  assert.deepEqual(await m.sendConfirm('a@b.test', 'tok', null), { sent: false, reason: 'no_provider' });
});
test('confirmação: e-mail com a marca Kobly, botão para o SITE da Kobly (nunca localhost) e token na URL', async () => {
  const calls = []; const m = createMailer({ apiKey: 'k', from: 'Kobly <no-reply@kobly.test>', siteUrl: 'https://app.kobly.test', fetchImpl: async (u, i) => { calls.push({ u, i }); return { ok: true }; }, log: quiet });
  assert.deepEqual(await m.sendConfirm('cli@x.test', 'T0K/en+1', null), { sent: true });
  const body = JSON.parse(calls[0].i.body);
  assert.equal(calls[0].u, 'https://api.resend.com/emails'); assert.equal(calls[0].i.headers.authorization, 'Bearer k');
  assert.deepEqual(body.to, ['cli@x.test']); assert.equal(body.from, 'Kobly <no-reply@kobly.test>'); assert.match(body.subject, /Kobly/);
  assert.match(body.html, /https:\/\/app\.kobly\.test\/assets\/kobly-logo-black\.png/); assert.match(body.html, /#ff6201/);
  assert.match(body.html, /https:\/\/app\.kobly\.test\/#type=confirm&amp;token=T0K%2Fen%2B1/);
  assert.ok(!/localhost/.test(body.html)); assert.match(body.text, /type=confirm/);
});
test('origem informada tem prioridade (aplicativo em outro endereço aprovado)', async () => {
  const m = createMailer({ siteUrl: 'https://app.kobly.test' });
  assert.equal(m.confirmLink('https://painel.kobly.test/', 'x'), 'https://painel.kobly.test/#type=confirm&token=x');
  assert.equal(m.inviteLink(null, 'x'), 'https://app.kobly.test/#type=recovery&token=x');
});
test('recuperação e convite usam o tipo de link que o aplicativo entende e textos próprios', async () => {
  const sent = []; const m = createMailer({ apiKey: 'k', siteUrl: 'https://s.test', fetchImpl: async (u, i) => { sent.push(JSON.parse(i.body)); return { ok: true }; }, log: quiet });
  await m.sendRecovery('a@b.test', 'r1', null); await m.sendInvite('a@b.test', 'i1', null, { nome: 'Ana', conta: 'Loja', convidadoPor: 'Agência' });
  assert.match(sent[0].html, /type=recovery&amp;token=r1/); assert.match(sent[0].subject, /senha/i);
  assert.match(sent[1].html, /type=recovery&amp;token=i1/); assert.match(sent[1].html, /Ana, sua conta está pronta/); assert.match(sent[1].html, /Loja/); assert.match(sent[1].html, /Agência/);
});
test('nomes digitados pelo usuário não injetam HTML no e-mail', async () => {
  const r = renderEmail({ site: 'https://s.test', title: '<script>x</script>', intro: 'ok', ctaLabel: '"><img>', ctaUrl: 'https://s.test/?a="b"', footnote: '<b>f</b>' });
  assert.ok(!r.html.includes('<script>')); assert.ok(!r.html.includes('"><img>')); assert.match(r.html, /&lt;script&gt;/);
});
test('falha do provedor ou da rede não quebra o cadastro: devolve sent:false', async () => {
  const a = createMailer({ apiKey: 'k', siteUrl: 'https://s.test', fetchImpl: async () => ({ ok: false, status: 422 }), log: quiet });
  assert.deepEqual(await a.sendConfirm('a@b.test', 't', null), { sent: false, reason: 'provider_422' });
  const b = createMailer({ apiKey: 'k', siteUrl: 'https://s.test', fetchImpl: async () => { throw new Error('rede'); }, log: quiet });
  assert.deepEqual(await b.sendConfirm('a@b.test', 't', null), { sent: false, reason: 'network' });
});
