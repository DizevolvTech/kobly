// Utilidades de modelo (template) do WhatsApp.

// Conta as variáveis {{1}}, {{2}}… do corpo (maior índice usado).
export function countVariables(text) {
  let max = 0;
  for (const m of String(text || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}
export function bodyOf(components) {
  const b = (components || []).find((c) => String(c.type).toUpperCase() === 'BODY');
  return b ? b.text || '' : '';
}
// Monta os `components` do envio: variáveis do corpo e, se houver, a do botão de URL.
export function buildSendComponents(template, vars = [], buttonUrlSuffix) {
  const out = [];
  const n = template.variable_count || 0;
  if (n > 0) {
    if (vars.length < n) throw Object.assign(new Error(`O modelo pede ${n} variável(is) e vieram ${vars.length}.`), { code: 'missing_variables' });
    out.push({ type: 'body', parameters: vars.slice(0, n).map((v) => ({ type: 'text', text: String(v ?? '').replace(/[\n\t]+/g, ' ').slice(0, 1024) || '-' })) });
  }
  const btns = ((template.components || []).find((c) => String(c.type).toUpperCase() === 'BUTTONS') || {}).buttons || [];
  btns.forEach((b, i) => {
    if (String(b.type).toUpperCase() === 'URL' && /\{\{\s*1\s*\}\}/.test(b.url || '')) {
      out.push({ type: 'button', sub_type: 'url', index: String(i), parameters: [{ type: 'text', text: String(buttonUrlSuffix ?? '') }] });
    }
  });
  return out;
}
// Número E.164 sem "+" (Brasil: 10/11 dígitos ganham 55).
export function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}
// Valida e normaliza um pedido de criação de modelo vindo da tela.
export function buildTemplateRequest({ name, language = 'pt_BR', category = 'MARKETING', body, examples = [], footer, buttons = [] }) {
  const n = String(name || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{1,512}$/.test(n)) throw Object.assign(new Error('Nome do modelo: só letras minúsculas, números e _.'), { code: 'bad_name' });
  if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category)) throw Object.assign(new Error('Categoria inválida.'), { code: 'bad_category' });
  const text = String(body || '').trim();
  if (!text || text.length > 1024) throw Object.assign(new Error('O texto do modelo precisa ter de 1 a 1024 caracteres.'), { code: 'bad_body' });
  const nv = countVariables(text);
  if (nv > 0 && (!Array.isArray(examples) || examples.length < nv)) throw Object.assign(new Error(`Informe um exemplo para cada uma das ${nv} variável(is).`), { code: 'missing_examples' });
  const components = [{ type: 'BODY', text, ...(nv ? { example: { body_text: [examples.slice(0, nv).map(String)] } } : {}) }];
  if (footer) components.push({ type: 'FOOTER', text: String(footer).slice(0, 60) });
  const btns = (buttons || []).slice(0, 3).map((b) => {
    const t = String(b.type || 'URL').toUpperCase();
    if (t === 'URL') {
      if (!/^https:\/\//i.test(b.url || '')) throw Object.assign(new Error('O botão de link precisa de uma URL https.'), { code: 'bad_button' });
      return { type: 'URL', text: String(b.text || 'Abrir').slice(0, 25), url: b.url, ...(/\{\{1\}\}/.test(b.url) ? { example: [b.example || 'abc'] } : {}) };
    }
    if (t === 'QUICK_REPLY') return { type: 'QUICK_REPLY', text: String(b.text || 'OK').slice(0, 25) };
    throw Object.assign(new Error('Tipo de botão não suportado.'), { code: 'bad_button' });
  });
  if (btns.length) components.push({ type: 'BUTTONS', buttons: btns });
  return { name: n, language, category, components };
}
