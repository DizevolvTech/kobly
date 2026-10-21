// WhatsApp oficial (Meta Cloud API), uma conta por organização.
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { AuthError } from '../auth.js';
import { MetaError } from './graph.js';
import { encrypt, decrypt } from './crypto.js';
import { countVariables, bodyOf, buildSendComponents, normalizePhone, buildTemplateRequest } from './templates.js';

const SAFE_COLS = 'id, organization_id, waba_id, phone_number_id, display_phone, verified_name, quality_rating, messaging_limit, status, last_error, webhook_public_id, verify_token, connected_at';
const OPT_OUT = /^\s*(sair|parar|pare|stop|cancelar|descadastrar|nao quero|não quero)\s*[.!]?\s*$/i;

function metaToHttp(e) {
  if (!(e instanceof MetaError)) return e;
  if (e.code === 190) return new AuthError(400, 'meta_token_invalid', 'O token de acesso da Meta é inválido ou expirou. Gere um novo e conecte de novo.');
  if (e.status === 502) return new AuthError(502, e.code, e.message);
  if (e.code === 100 || e.status === 400 || e.status === 404) return new AuthError(400, 'meta_rejected', `A Meta recusou: ${e.message}`);
  if (e.status === 401 || e.status === 403) return new AuthError(400, 'meta_forbidden', 'Este token não tem permissão para esse número/conta. Confira as permissões do token.');
  return new AuthError(502, 'meta_error', `Erro da Meta: ${e.message}`);
}

export function createWhatsapp({ pool, graph, secretKey, publicBaseUrl, globalAppSecret }) {
  const view = (row) => row && ({
    id: row.id, organization_id: row.organization_id, waba_id: row.waba_id, phone_number_id: row.phone_number_id,
    display_phone: row.display_phone, verified_name: row.verified_name, quality_rating: row.quality_rating,
    messaging_limit: row.messaging_limit, status: row.status, last_error: row.last_error, connected_at: row.connected_at,
    webhook_url: `${publicBaseUrl}/webhooks/whatsapp/${row.webhook_public_id}`, verify_token: row.verify_token,
    has_app_secret: !!row.app_secret_enc,
  });

  // Resolve a organização alvo e confere que o usuário PODE mexer nela (mesma regra da RLS do banco).
  async function resolveOrg(user, orgId) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role kobly_authenticated`);
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user.id, role: 'kobly_authenticated' })]);
      let target = orgId;
      if (!target) {
        const p = await client.query(`select organization_id from public.profiles where auth_id = auth.uid()`);
        target = p.rows[0] && p.rows[0].organization_id;
      }
      if (!target) throw new AuthError(400, 'no_org', 'Sua conta ainda não tem uma empresa.');
      const ok = await client.query(`select public.has_org_access($1::uuid) as ok`, [target]);
      if (!ok.rows[0].ok) throw new AuthError(403, 'forbidden', 'Você não tem acesso a esta empresa.');
      // quem só atende chamados (Suporte) não configura canais do cliente
      const role = await client.query(`select tipo_user_geral from public.profiles where auth_id = auth.uid()`);
      await client.query('commit');
      return { orgId: target, role: role.rows[0] && role.rows[0].tipo_user_geral };
    } catch (e) { try { await client.query('rollback'); } catch {} throw e; } finally { client.release(); }
  }
  const requireManager = (ctx) => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar a conexão do WhatsApp.'); };

  async function accountRow(orgId) {
    const { rows } = await pool.query(`select * from public.whatsapp_accounts where organization_id = $1`, [orgId]);
    return rows[0] || null;
  }
  const needKey = () => { if (!secretKey) throw new AuthError(503, 'whatsapp_unconfigured', 'O WhatsApp ainda não foi configurado neste ambiente (chave de segurança ausente).'); };
  const tokenOf = (row) => { needKey(); return decrypt(row.token_enc, secretKey); };

  async function connect(ctx, { waba_id, phone_number_id, access_token, app_secret }) {
    requireManager(ctx);
    needKey();
    const waba = String(waba_id || '').trim(); const pid = String(phone_number_id || '').trim(); const tok = String(access_token || '').trim();
    if (!/^\d{5,25}$/.test(waba) || !/^\d{5,25}$/.test(pid)) throw new AuthError(422, 'validation_failed', 'ID da conta WhatsApp Business e ID do número devem ser só números.');
    if (tok.length < 20) throw new AuthError(422, 'validation_failed', 'Informe o token de acesso.');
    let info;
    try { info = await graph.getPhoneNumber(pid, tok); await graph.getWaba(waba, tok); }
    catch (e) { throw metaToHttp(e); }
    const existing = await accountRow(ctx.orgId);
    // um mesmo número não pode estar em duas empresas
    const dup = await pool.query(`select organization_id from public.whatsapp_accounts where phone_number_id = $1 and organization_id <> $2`, [pid, ctx.orgId]);
    if (dup.rows[0]) throw new AuthError(409, 'phone_in_use', 'Este número já está conectado em outra empresa.');
    const verify = existing ? existing.verify_token : randomBytes(18).toString('base64url');
    const args = [ctx.orgId, waba, pid, info.display_phone_number || null, info.verified_name || null, info.quality_rating || null, info.messaging_limit_tier || null,
      verify, encrypt(tok, secretKey), app_secret ? encrypt(String(app_secret).trim(), secretKey) : null];
    const { rows } = await pool.query(
      `insert into public.whatsapp_accounts (organization_id, waba_id, phone_number_id, display_phone, verified_name, quality_rating, messaging_limit, status, last_error, verify_token, token_enc, app_secret_enc, connected_at)
       values ($1,$2,$3,$4,$5,$6,$7,'connected',null,$8,$9,$10, now())
       on conflict (organization_id) do update set waba_id = excluded.waba_id, phone_number_id = excluded.phone_number_id, display_phone = excluded.display_phone,
         verified_name = excluded.verified_name, quality_rating = excluded.quality_rating, messaging_limit = excluded.messaging_limit, status = 'connected', last_error = null,
         token_enc = excluded.token_enc, app_secret_enc = coalesce(excluded.app_secret_enc, public.whatsapp_accounts.app_secret_enc), connected_at = now()
       returning *`, args);
    // assina a conta para receber os avisos (falha aqui não desfaz a conexão; vira aviso)
    let webhookWarning = null;
    try { await graph.subscribeApp(waba, tok); } catch (e) { webhookWarning = 'Conectado, mas não consegui assinar os avisos de entrega automaticamente. Configure o webhook no painel da Meta com a URL abaixo.'; }
    return { account: view(rows[0]), webhookWarning };
  }

  async function status(ctx, { refresh } = {}) {
    let row = await accountRow(ctx.orgId);
    if (!row) return { connected: false, account: null };
    if (refresh) {
      try {
        const info = await graph.getPhoneNumber(row.phone_number_id, tokenOf(row));
        const r = await pool.query(`update public.whatsapp_accounts set display_phone=$2, verified_name=$3, quality_rating=$4, messaging_limit=$5, status='connected', last_error=null where id=$1 returning *`,
          [row.id, info.display_phone_number || row.display_phone, info.verified_name || row.verified_name, info.quality_rating || row.quality_rating, info.messaging_limit_tier || row.messaging_limit]);
        row = r.rows[0];
      } catch (e) {
        const he = metaToHttp(e);
        const r = await pool.query(`update public.whatsapp_accounts set status='error', last_error=$2 where id=$1 returning *`, [row.id, he.message]);
        row = r.rows[0];
      }
    }
    return { connected: row.status === 'connected', account: view(row) };
  }

  async function disconnect(ctx) {
    requireManager(ctx);
    await pool.query(`delete from public.whatsapp_accounts where organization_id = $1`, [ctx.orgId]);
    return { ok: true };
  }

  async function upsertTemplate(row, t) {
    const body = bodyOf(t.components);
    await pool.query(
      `insert into public.whatsapp_templates (organization_id, account_id, name, language, category, status, meta_template_id, components, body_text, variable_count, rejected_reason, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11, now())
       on conflict (account_id, name, language) do update set category=excluded.category, status=excluded.status, meta_template_id=excluded.meta_template_id,
         components=excluded.components, body_text=excluded.body_text, variable_count=excluded.variable_count, rejected_reason=excluded.rejected_reason, synced_at=now()`,
      [row.organization_id, row.id, t.name, t.language, t.category || 'MARKETING', t.status || 'PENDING', t.id || null, JSON.stringify(t.components || []), body, countVariables(body), t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null]);
  }

  async function syncTemplates(ctx) {
    const row = await accountRow(ctx.orgId);
    if (!row) throw new AuthError(400, 'not_connected', 'Conecte o WhatsApp primeiro.');
    let list;
    try { list = await graph.listTemplates(row.waba_id, tokenOf(row)); } catch (e) { throw metaToHttp(e); }
    for (const t of list) await upsertTemplate(row, t);
    return { synced: list.length };
  }

  async function createTemplate(ctx, input) {
    requireManager(ctx);
    const row = await accountRow(ctx.orgId);
    if (!row) throw new AuthError(400, 'not_connected', 'Conecte o WhatsApp primeiro.');
    let req;
    try { req = buildTemplateRequest(input); } catch (e) { throw new AuthError(422, e.code || 'validation_failed', e.message); }
    let out;
    try { out = await graph.createTemplate(row.waba_id, tokenOf(row), req); } catch (e) { throw metaToHttp(e); }
    await upsertTemplate(row, { ...req, id: out.id, status: out.status || 'PENDING' });
    return { id: out.id, status: out.status || 'PENDING' };
  }

  // Envia um modelo a UM número. Usado no teste e (depois) pelo motor de campanhas.
  async function sendTemplateTo(orgId, { to, template_id, variables = [], button_suffix }) {
    const row = await accountRow(orgId);
    if (!row) throw new AuthError(400, 'not_connected', 'Conecte o WhatsApp primeiro.');
    const phone = normalizePhone(to);
    if (!phone) throw new AuthError(422, 'bad_phone', 'Número inválido. Use DDD + número.');
    const { rows } = await pool.query(`select * from public.whatsapp_templates where id = $1 and organization_id = $2`, [template_id, orgId]);
    const tpl = rows[0];
    if (!tpl) throw new AuthError(404, 'template_not_found', 'Modelo não encontrado.');
    if (tpl.status !== 'APPROVED') throw new AuthError(409, 'template_not_approved', `Este modelo está "${tpl.status}". Só modelos aprovados pela Meta podem ser enviados.`);
    let components;
    try { components = buildSendComponents(tpl, variables, button_suffix); } catch (e) { throw new AuthError(422, e.code || 'validation_failed', e.message); }
    try {
      const out = await graph.sendTemplate(row.phone_number_id, tokenOf(row), { to: phone, name: tpl.name, language: tpl.language, components });
      return { ok: true, id: (out.messages && out.messages[0] && out.messages[0].id) || null, to: phone };
    } catch (e) { throw metaToHttp(e); }
  }

  // ---- Webhook da Meta ------------------------------------------------------
  async function verifyWebhook(publicId, mode, token, challenge) {
    const { rows } = await pool.query(`select verify_token from public.whatsapp_accounts where webhook_public_id::text = $1`, [publicId]);
    const ok = rows[0] && mode === 'subscribe' && token && timingEq(token, rows[0].verify_token);
    return ok ? String(challenge ?? '') : null;
  }
  function timingEq(a, b) { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); }

  async function receiveWebhook(publicId, rawBody, signatureHeader) {
    const { rows } = await pool.query(`select * from public.whatsapp_accounts where webhook_public_id::text = $1`, [publicId]);
    const row = rows[0];
    if (!row) return { status: 404 };
    needKey();
    const secret = row.app_secret_enc ? decrypt(row.app_secret_enc, secretKey) : globalAppSecret;
    if (!secret) return { status: 403, reason: 'sem app secret para validar a assinatura' };
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!signatureHeader || !timingEq(signatureHeader, expected)) return { status: 403, reason: 'assinatura inválida' };
    let payload; try { payload = JSON.parse(rawBody.toString()); } catch { return { status: 200, ignored: 'json' }; }
    const stats = { statuses: 0, templates: 0, optOuts: 0 };
    for (const entry of payload.entry || []) for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (ch.field === 'messages') {
        if (v.metadata && v.metadata.phone_number_id && v.metadata.phone_number_id !== row.phone_number_id) continue; // outro número
        for (const s of v.statuses || []) stats.statuses += await recordStatus(row, s);
        for (const m of v.messages || []) if (m.type === 'text' && OPT_OUT.test(m.text && m.text.body || '')) stats.optOuts += await optOut(row, m.from);
      } else if (ch.field === 'message_template_status_update') {
        const r = await pool.query(
          `update public.whatsapp_templates set status = $3, rejected_reason = $4, synced_at = now()
            where account_id = $1 and (meta_template_id = $2 or (name = $5 and language = coalesce($6, language)))`,
          [row.id, String(v.message_template_id || ''), String(v.event || '').toUpperCase(), v.reason && v.reason !== 'NONE' ? v.reason : null, v.message_template_name || '', v.message_template_language || null]);
        stats.templates += r.rowCount;
      } else if (ch.field === 'phone_number_quality_update') {
        await pool.query(`update public.whatsapp_accounts set quality_rating = coalesce($2, quality_rating), messaging_limit = coalesce($3, messaging_limit) where id = $1`,
          [row.id, v.current_quality_rating || null, v.current_limit || null]);
      }
    }
    return { status: 200, ...stats };
  }

  const STATUS = { delivered: 'entregue', read: 'lido', failed: 'falha' };
  async function recordStatus(row, s) {
    const mapped = STATUS[s.status];
    if (!mapped || !s.id) return 0;
    const send = await pool.query(
      `select organization_id, campaign_id, email from public.email_events where sg_message_id = $1 and channel = 'whatsapp' and event = 'send' and organization_id = $2 limit 1`, [s.id, row.organization_id]);
    if (!send.rows[0]) return 0;
    const reason = mapped === 'falha' ? String((s.errors && s.errors[0] && (s.errors[0].title || s.errors[0].message)) || 'falha no envio').slice(0, 300) : null;
    try {
      await pool.query(
        `insert into public.email_events (organization_id, campaign_id, event, channel, status, reason, email, sg_message_id, "timestamp")
         values ($1,$2,'status','whatsapp',$3,$4,$5,$6, now())`, [send.rows[0].organization_id, send.rows[0].campaign_id, mapped, reason, send.rows[0].email, s.id]);
      return 1;
    } catch (e) { if (e.code === '23505') return 0; throw e; } // reentrega do mesmo status: a unique parcial já cobre; outro erro aparece
  }
  async function optOut(row, from) {
    const phone = String(from || '').replace(/\D/g, '');
    if (phone.length < 10) return 0;
    const tail = phone.slice(-10); // casa com ou sem 55 e com/sem o 9
    const r = await pool.query(
      `update public.leads set whatsapp_opt_out = true where organization_id = $1 and right(regexp_replace(coalesce(telefone,''), '\\D', '', 'g'), 10) = $2 and not whatsapp_opt_out`, [row.organization_id, tail]);
    return r.rowCount;
  }

  return { resolveOrg, connect, status, disconnect, syncTemplates, createTemplate, sendTemplateTo, verifyWebhook, receiveWebhook, view, SAFE_COLS };
}
