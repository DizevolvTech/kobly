// Entrada de vendas: POST /functions/v1/postback-receiver?token=pbk_xxx (público; o token autentica a empresa).
// Portado de supabase/functions/postback-receiver. Regra de ouro: NUNCA responder 4xx/5xx por evento
// desconhecido ou erro interno (plataformas como a Hotmart desativam o webhook que falha) — só token/JSON inválidos.
import { normalizePayload, extractRecoveryLink, deadLetterPayload, RATE_LIMIT_PER_MIN } from './normalize.js';

export function createPostback({ pool }) {
  const deadLetter = (org, tokenId, reason, detail, raw, parsed) =>
    pool.query(`insert into public.webhook_dead_letter (organization_id, postback_token_id, provider, reason, detail, raw_payload) values ($1,$2,'postback',$3,$4,$5)`,
      [org, tokenId, reason, detail, JSON.stringify(deadLetterPayload(raw, parsed))]).catch((e) => console.error('[postback] dead-letter falhou:', e.message));

  async function receive(token, rawBody) {
    if (!token) return { status: 401, body: { error: 'missing_token', detail: 'Adicione ?token=pbk_xxx na URL' } };
    let body;
    try { body = JSON.parse(rawBody || '{}'); } catch { return { status: 400, body: { error: 'invalid_json' } }; }
    try {
      const t = await pool.query(`select id, organization_id from public.postback_tokens where token = $1 and ativo = true`, [token]);
      if (!t.rows[0]) return { status: 401, body: { error: 'invalid_token', detail: 'Token inválido ou inativo' } };
      const org = t.rows[0].organization_id, tokenId = t.rows[0].id;

      const rl = await pool.query(`select (select count(*) from public.webhook_events where organization_id = $1 and created_at >= now() - interval '60 seconds')
        + (select count(*) from public.webhook_dead_letter where organization_id = $1 and created_at >= now() - interval '60 seconds') as n`, [org]).catch(() => ({ rows: [{ n: 0 }] }));
      const recent = Number(rl.rows[0].n);
      if (recent > RATE_LIMIT_PER_MIN) {
        await deadLetter(org, tokenId, 'rate_limited', `recent=${recent} limit=${RATE_LIMIT_PER_MIN}`, rawBody, body);
        return { status: 200, body: { ok: true, ignored: true, reason: 'rate_limited' } };
      }

      const norm = normalizePayload(body);
      if (!norm) {
        const received = body?.event ?? body?.transaction?.payment_status ?? body?.status ?? null;
        await deadLetter(org, tokenId, 'unknown_event_or_missing_email', received != null ? `received_event=${String(received)}` : null, rawBody, body);
        return { status: 200, body: { ok: true, ignored: true, reason: 'unknown_event_or_missing_email', received_event: received } };
      }
      const tipo = norm.tipoEvento;
      const idWebhook = norm.externalId ? `${org}:${norm.externalId}` : `pbk:${crypto.randomUUID()}`;
      const isPix = norm.isPix ?? norm.sourceEvent === 'pix_generated';
      const link = extractRecoveryLink(body);

      let webhookEventId;
      try {
        const ins = await pool.query(`insert into public.webhook_events (organization_id, tipo_evento, provider, id_webhook, email, nome_comprador, produto, valor_produto, metodo_pagamento, pix_gerado, checkout_url, payload)
          values ($1,$2,'postback',$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
          [org, tipo, idWebhook, norm.email, norm.name, norm.product, norm.value, norm.paymentMethod, isPix, link, JSON.stringify(body)]);
        webhookEventId = ins.rows[0].id;
      } catch (e) {
        if (e.code !== '23505') await deadLetter(org, tokenId, 'insert_failed', e.message, rawBody, body);
        return { status: 200, body: { ok: true, deduped: true, detail: e.message } };
      }

      // Lead por (empresa, e-mail); só sobrescreve telefone/link quando o evento trouxe um.
      let leadId;
      const ex = await pool.query(`select id from public.leads where organization_id = $1 and email = $2`, [org, norm.email]);
      if (ex.rows[0]) {
        leadId = ex.rows[0].id;
        await pool.query(`update public.leads set ultimo_evento = $2, produto = $3, valor_compra = $4, metodo_pagamento = $5, pix_gerado = $6,
          telefone = coalesce($7, telefone), link_recuperacao = coalesce($8, link_recuperacao) where id = $1`,
          [leadId, tipo, norm.product, norm.value, norm.paymentMethod, isPix, norm.phone || null, link || null]);
      } else {
        const nl = await pool.query(`insert into public.leads (organization_id, email, nome, telefone, produto, valor_compra, metodo_pagamento, pix_gerado, ultimo_evento, link_recuperacao)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [org, norm.email, norm.name, norm.phone, norm.product, norm.value, norm.paymentMethod, isPix, tipo, link]);
        leadId = nl.rows[0].id;
      }
      await pool.query(`update public.webhook_events set lead_id = $2 where id = $1`, [webhookEventId, leadId]);

      // Venda recuperada: 1ª compra aprovada do lead, creditada às campanhas que já enviaram e-mail a ele antes.
      if (tipo === 'Compra Aprovada') {
        const c = await pool.query(`select count(*)::int n from public.webhook_events where organization_id = $1 and lead_id = $2 and tipo_evento = 'Compra Aprovada'`, [org, leadId]);
        if (c.rows[0].n <= 1) {
          const sent = await pool.query(`select distinct campaign_id from public.email_events where organization_id = $1 and email = $2 and status = 'enviado'
            and campaign_id is not null and "timestamp" < now() and (channel is null or channel = 'email')`, [org, norm.email]);
          for (const r of sent.rows) await pool.query(`select public.increment_vendas_recuperadas($1)`, [r.campaign_id]).catch((e) => console.error('[postback] vendas_recuperadas:', e.message));
        }
      }

      // Enfileira os passos das campanhas ATIVAS cujo gatilho casa (sem vínculo de token ou vinculadas a este).
      const camps = await pool.query(`select c.id, f.id as flow_id,
          coalesce(json_agg(json_build_object('id', s.id, 'tipo_card', s.tipo_card, 'tipo_evento', s.tipo_evento, 'atraso', s.atraso, 'posicao', s.posicao)) filter (where s.id is not null), '[]') as steps
        from public.campaigns c join public.campaign_flows f on f.campaign_id = c.id left join public.flow_steps s on s.flow_id = f.id
        where c.organization_id = $1 and c.status_campanha = 'Ativa' and (c.postback_token_id is null or c.postback_token_id = $2)
        group by c.id, f.id`, [org, tokenId]);
      let enqueued = 0, casados = 0, falhos = 0; const acionadas = new Set(); const campIds = new Set(camps.rows.map((r) => r.id));
      for (const row of camps.rows) {
        const steps = row.steps;
        if (!steps.some((s) => s.tipo_card === 'Gatilho' && s.tipo_evento === tipo)) continue;
        casados++;
        const acoes = steps.filter((s) => s.tipo_card !== 'Gatilho' && s.tipo_card !== 'Condição').sort((a, b) => a.posicao - b.posicao);
        let acc = 0; const now = Date.now();
        const rows = acoes.map((s) => { acc += Number(s.atraso) || 0; return [s.id, new Date(now + acc * 60000).toISOString()]; });
        if (!rows.length) continue;
        try {
          await pool.query(`insert into public.scheduled_steps (organization_id, step_id, lead_id, webhook_event_id, status_agendamento, run_at)
            select $1, x.step, $2, $3, 'Iniciado', x.run_at from unnest($4::uuid[], $5::timestamptz[]) as x(step, run_at)`,
            [org, leadId, webhookEventId, rows.map((r) => r[0]), rows.map((r) => r[1])]);
          enqueued += rows.length; acionadas.add(row.id);
        } catch (e) { falhos++; console.error('[postback] scheduled_steps falhou:', e.message); }
      }
      let motivo = null;
      if (enqueued === 0) motivo = falhos ? 'insert_falhou' : campIds.size === 0 ? 'nenhuma_campanha_ativa_para_este_token' : casados === 0 ? 'nenhum_gatilho_casa_com_o_evento' : 'campanha_sem_acoes';
      return { status: 200, body: { ok: true, event: norm.sourceEvent, tipo_evento: tipo, lead_id: leadId, webhook_event_id: webhookEventId, enqueued, campanhas_acionadas: [...acionadas], ...(motivo ? { motivo_sem_agendamento: motivo } : {}) } };
    } catch (e) {
      console.error('[postback] erro não tratado:', e.message);
      return { status: 200, body: { ok: true, ignored: true, reason: 'internal_error' } };
    }
  }
  return { receive };
}
