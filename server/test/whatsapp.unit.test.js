import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, parseKey } from '../src/whatsapp/crypto.js';
import { countVariables, bodyOf, buildSendComponents, normalizePhone, buildTemplateRequest } from '../src/whatsapp/templates.js';
import { createGraph, MetaError } from '../src/whatsapp/graph.js';

const key = randomBytes(32);
test('cripto: ida e volta; cada cifra é diferente; chave errada e adulteração falham', () => {
  const a = encrypt('EAAG-token-secreto', key); const b = encrypt('EAAG-token-secreto', key);
  assert.notEqual(a, b); assert.ok(!a.includes('EAAG'));
  assert.equal(decrypt(a, key), 'EAAG-token-secreto');
  assert.throws(() => decrypt(a, randomBytes(32)));
  const parts = a.split('.'); parts[3] = Buffer.from('x' + Buffer.from(parts[3], 'base64url').toString('latin1').slice(1), 'latin1').toString('base64url');
  assert.throws(() => decrypt(parts.join('.'), key));
  assert.throws(() => decrypt('lixo', key));
  assert.throws(() => parseKey('curta'));
  assert.equal(parseKey(key.toString('base64')).length, 32);
});

test('modelo: conta variáveis e extrai o corpo', () => {
  assert.equal(countVariables('Oi {{1}}, seu pedido {{2}} e {{ 3 }}'), 3);
  assert.equal(countVariables('sem variável'), 0);
  assert.equal(bodyOf([{ type: 'HEADER' }, { type: 'BODY', text: 'olá' }]), 'olá');
});
test('envio: monta variáveis do corpo e a do botão de URL; falta variável é erro', () => {
  const tpl = { variable_count: 2, components: [{ type: 'BODY', text: 'a {{1}} b {{2}}' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'ok' }, { type: 'URL', text: 'ver', url: 'https://x.com/{{1}}' }] }] };
  const c = buildSendComponents(tpl, ['Ana', 'Tênis\nazul'], 'abc123');
  assert.deepEqual(c[0], { type: 'body', parameters: [{ type: 'text', text: 'Ana' }, { type: 'text', text: 'Tênis azul' }] });
  assert.deepEqual(c[1], { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'abc123' }] });
  assert.throws(() => buildSendComponents(tpl, ['só uma']), /pede 2 variável/);
  assert.deepEqual(buildSendComponents({ variable_count: 0, components: [] }, []), []);
});
test('telefone: BR com/sem 55, lixo e tamanhos', () => {
  assert.equal(normalizePhone('(11) 98888-7777'), '5511988887777');
  assert.equal(normalizePhone('+55 11 98888-7777'), '5511988887777');
  assert.equal(normalizePhone('1198'), null); assert.equal(normalizePhone(''), null);
});
test('criação de modelo: valida nome, categoria, tamanho, exemplos e botões', () => {
  const ok = buildTemplateRequest({ name: 'Carrinho_1', body: 'Oi {{1}}!', examples: ['Ana'], buttons: [{ type: 'URL', text: 'Finalizar', url: 'https://loja.com/{{1}}', example: 'x' }], footer: 'Responda SAIR' });
  assert.equal(ok.name, 'carrinho_1'); assert.deepEqual(ok.components[0].example, { body_text: [['Ana']] });
  assert.equal(ok.components[2].buttons[0].type, 'URL');
  assert.throws(() => buildTemplateRequest({ name: 'Nome inválido!', body: 'x' }), /Nome do modelo/);
  assert.throws(() => buildTemplateRequest({ name: 'a', body: 'x', category: 'SPAM' }), /Categoria/);
  assert.throws(() => buildTemplateRequest({ name: 'a', body: '' }), /1 a 1024/);
  assert.throws(() => buildTemplateRequest({ name: 'a', body: 'x'.repeat(1025) }), /1 a 1024/);
  assert.throws(() => buildTemplateRequest({ name: 'a', body: 'Oi {{1}}', examples: [] }), /exemplo/);
  assert.throws(() => buildTemplateRequest({ name: 'a', body: 'x', buttons: [{ type: 'URL', url: 'http://inseguro.com' }] }), /https/);
  assert.throws(() => buildTemplateRequest({ name: 'a', body: 'x', buttons: [{ type: 'PHONE_NUMBER' }] }), /não suportado/);
});

const resp = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
test('graph: monta URL/cabeçalho, pagina modelos e mapeia erros da Meta', async () => {
  const calls = [];
  const g = createGraph({ base: 'https://graph.test/v21.0', fetchImpl: async (u, i) => {
    calls.push({ u: String(u), i });
    if (String(u).includes('message_templates') && !String(u).includes('after=')) return resp(200, { data: [{ id: '1', name: 'a' }], paging: { cursors: { after: 'C2' }, next: 'x' } });
    if (String(u).includes('message_templates')) return resp(200, { data: [{ id: '2', name: 'b' }] });
    if (String(u).includes('/messages')) return resp(200, { messages: [{ id: 'wamid.X' }] });
    return resp(401, { error: { code: 190, message: 'expired' } });
  } });
  const all = await g.listTemplates('123', 'TOK');
  assert.deepEqual(all.map((t) => t.id), ['1', '2']);
  assert.equal(calls[0].i.headers.Authorization, 'Bearer TOK');
  const sent = await g.sendTemplate('999', 'TOK', { to: '5511', name: 'n', language: 'pt_BR', components: [] });
  assert.equal(sent.messages[0].id, 'wamid.X');
  assert.deepEqual(JSON.parse(calls[2].i.body), { messaging_product: 'whatsapp', to: '5511', type: 'template', template: { name: 'n', language: { code: 'pt_BR' } } });
  await assert.rejects(g.getPhoneNumber('1', 'TOK'), (e) => e instanceof MetaError && e.code === 190);
  const down = createGraph({ fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(down.getWaba('1', 't'), (e) => e.code === 'meta_unreachable');
});
