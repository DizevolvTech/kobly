import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCtaLink, resolveVars, retryable, formatBRL, isUsableLink } from '../src/engine/steps.js';
import { normalizePayload, extractRecoveryLink } from '../src/ingest/normalize.js';

test('link de recuperação: evento > lead > loja > "#"; lixo é ignorado', () => {
  assert.equal(resolveCtaLink({ evento: 'https://a.test/x', lead: 'https://b.test', brand: 'https://c.test' }), 'https://a.test/x');
  assert.equal(resolveCtaLink({ evento: 'javascript:alert(1)', lead: 'https://b.test', brand: null }), 'https://b.test');
  assert.equal(resolveCtaLink({ evento: 'https://a b', lead: null, brand: 'https://c.test' }), 'https://c.test');
  assert.equal(resolveCtaLink({}), '#'); assert.equal(isUsableLink('ftp://x.test'), false);
});
test('variáveis do modelo: campo do lead ou texto fixo, na ordem', () => {
  const v = resolveVars(['nome', '{{produto}}', 'valor', 'cta_link', 'Olá fixo'], { lead: { nome: 'Ana', produto: null, valor_compra: 99.9 }, ctaLink: 'https://l.test', brand: {} });
  assert.deepEqual(v, ['Ana', 'seu pedido', formatBRL(99.9), 'https://l.test', 'Olá fixo']);
  assert.deepEqual(resolveVars(null, { lead: {}, ctaLink: '#' }), []);
});
test('quais erros repetem: indisponibilidade/limite/token (global) repetem; destinatário inválido não', () => {
  for (const st of [401, 402, 408, 409, 429, 500, 503]) assert.equal(retryable(st), true, String(st));
  for (const st of [400, 403, 404, 422]) assert.equal(retryable(st), false, String(st));
  assert.equal(retryable(404, 'not_connected'), true);
});
test('normalização: genérico, Hotmart, NexoPayt e ENTITY; sem e-mail ou evento estranho → null', () => {
  assert.equal(normalizePayload({ event: 'cart_abandoned', email: 'a@x.test' }).tipoEvento, 'Abandono de carrinho');
  assert.equal(normalizePayload({ event: 'PURCHASE_APPROVED', data: { buyer: { email: 'h@x.test' }, purchase: { transaction: 'T1' } } }).externalId, 'T1:Compra Aprovada');
  assert.equal(normalizePayload({ customer: { email: 'n@x.test' }, transaction: { payment_status: 'waiting_payment', payment_method: 'pix', total_price: '197.90' } }).value, 197.9);
  assert.equal(normalizePayload({ kind: 'ENTITY', event: 'entity.transaction.paid', data: { customer: { email: 'e@x.test' }, status: { value: 'paid' }, amount: 1490, id: 'z' } }).value, 14.9);
  assert.equal(normalizePayload({ event: 'pix_generated' }), null); assert.equal(normalizePayload({ event: 'nada', email: 'a@x.test' }), null);
  assert.equal(extractRecoveryLink({ metadata: { checkout_url: 'https://loja.test/c' }, logo_url: 'https://img.test/l.png' }), 'https://loja.test/c');
  assert.equal(extractRecoveryLink({ checkout_url: 'https://a b' }), null);
});
