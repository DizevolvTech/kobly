// Descadastro por link (público). GET só mostra a confirmação (scanners de link não descadastram ninguém);
// POST grava a supressão. One-click (RFC 8058) = POST sem corpo. Token assinado por HMAC: <b64(org:email:ts)>.<b64(hmac)>.
import { createHmac, timingSafeEqual } from 'node:crypto';
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function signUnsubToken(secret, orgId, email, ts = Date.now()) {
  const payload = `${orgId}:${String(email).toLowerCase()}:${ts}`;
  return `${b64(payload)}.${b64(createHmac('sha256', secret).update(payload).digest())}`;
}
export function verifyUnsubToken(secret, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !secret) return null;
  let payload; try { payload = Buffer.from(parts[0], 'base64url').toString('utf8'); } catch { return null; }
  const want = createHmac('sha256', secret).update(payload).digest();
  let got; try { got = Buffer.from(parts[1], 'base64url'); } catch { return null; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const i = payload.indexOf(':'), j = payload.lastIndexOf(':');
  const orgId = payload.slice(0, i), email = payload.slice(i + 1, j);
  return UUID.test(orgId) && email.includes('@') ? { orgId, email } : null;
}

const html = (title, body, status = 200) => ({ status, type: 'text/html; charset=utf-8', body:
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Descadastro</title>`
  + `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:12vh auto;text-align:center;color:#111"><h2 style="font-size:18px">${esc(title)}</h2>${body}</div>` });

export function createUnsubscribe({ pool, secret }) {
  async function handle(method, token, rawBody, queryConfirm) {
    let confirm = queryConfirm;
    if (method === 'POST' && rawBody) {
      try { const j = JSON.parse(rawBody); if (!token && j.token) token = String(j.token); if (String(j.confirm) === '1') confirm = true; }
      catch { const p = new URLSearchParams(rawBody); if (!token && p.get('token')) token = p.get('token'); if (p.get('confirm') === '1') confirm = true; }
    }
    const v = verifyUnsubToken(secret, token);
    if (!v) return html('Link de descadastro inválido.', '', 400);
    if (method === 'GET') return html('Confirmar descadastro', `<p style="color:#555;font-size:14px;margin:8px 0 20px">Clique no botão abaixo para não receber mais estes e-mails.</p><form method="POST" action=""><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="confirm" value="1"><button type="submit" style="font:inherit;padding:10px 20px;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer">Confirmar descadastro</button></form>`);
    await pool.query(`insert into public.email_suppressions (email, organization_id, reason, source) values ($1,$2,'unsubscribe',$3) on conflict (email, organization_id) do nothing`, [v.email.toLowerCase(), v.orgId, confirm ? 'link' : 'header']);
    return confirm ? html('Pronto! Você não receberá mais estes e-mails.', '') : { status: 200, type: 'text/plain', body: '' };
  }
  return { handle };
}
