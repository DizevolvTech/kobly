// Cliente mínimo da Graph API da Meta (WhatsApp Cloud API). Sem dependências; `fetch` injetável.
export class MetaError extends Error {
  constructor(status, code, message, subcode) { super(message); this.status = status; this.code = code; this.subcode = subcode; }
}

export function createGraph({ base = 'https://graph.facebook.com/v21.0', fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  async function call(method, path, token, body, query) {
    const url = new URL(base.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) { throw new MetaError(502, 'meta_unreachable', 'Não foi possível falar com a Meta agora.'); }
    let j = null; try { j = await res.json(); } catch { /* corpo vazio */ }
    if (!res.ok) {
      const e = (j && j.error) || {};
      // 190 = token inválido/expirado; 100 = parâmetro inválido; 131xxx = erros de envio do WhatsApp
      throw new MetaError(res.status, e.code || res.status, e.error_user_msg || e.message || 'Erro da Meta', e.error_subcode);
    }
    return j;
  }

  return {
    getPhoneNumber: (phoneNumberId, token) =>
      call('GET', `/${encodeURIComponent(phoneNumberId)}`, token, null, { fields: 'display_phone_number,verified_name,quality_rating,messaging_limit_tier,code_verification_status' }),
    getWaba: (wabaId, token) => call('GET', `/${encodeURIComponent(wabaId)}`, token, null, { fields: 'id,name' }),
    async listTemplates(wabaId, token) {
      const out = []; let after;
      for (let i = 0; i < 20; i++) { // teto de páginas
        const j = await call('GET', `/${encodeURIComponent(wabaId)}/message_templates`, token, null,
          { fields: 'id,name,language,category,status,components,rejected_reason', limit: '100', after });
        out.push(...(j.data || []));
        after = j.paging && j.paging.cursors && j.paging.next ? j.paging.cursors.after : null;
        if (!after) break;
      }
      return out;
    },
    createTemplate: (wabaId, token, tpl) => call('POST', `/${encodeURIComponent(wabaId)}/message_templates`, token, tpl),
    sendTemplate: (phoneNumberId, token, { to, name, language, components }) =>
      call('POST', `/${encodeURIComponent(phoneNumberId)}/messages`, token, {
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name, language: { code: language }, ...(components && components.length ? { components } : {}) },
      }),
    subscribeApp: (wabaId, token) => call('POST', `/${encodeURIComponent(wabaId)}/subscribed_apps`, token, {}),
  };
}
