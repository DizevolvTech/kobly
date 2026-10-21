// Motor de disparos: executa os passos agendados (scheduled_steps) vencidos.
// Portado de supabase/functions/process-steps. Canais prontos: WhatsApp (API oficial, modelo aprovado) e tags.
// E-mail e SMS ainda não foram portados: seus passos NÃO são tocados (ficam na fila, sem perda).
// Garantias: lease por passo (dois workers não pegam o mesmo), retry com backoff, desistência após MAX_ATTEMPTS,
// descadastro (SAIR) respeitado, passo pulado se a compra já aconteceu (condição), cota estornada na desistência.
const MAX_ATTEMPTS = 4;
const RETRY_BACKOFF_MIN = 5;
const LEASE_MIN = 10;
const BATCH = 50;
const EVENTOS_RECUPERACAO = new Set(['Abandono de carrinho', 'Pix Gerado', 'Boleto Gerado', 'Depósito Solicitado', 'Compra Recusada']);
const PULADO_SEM_LINK = 'pulado: sem link de recuperação';
const NON_FATAL = new Set([401, 402, 408, 409, 429]);

export const isUsableLink = (v) => { if (typeof v !== 'string') return false; const s = v.trim(); if (!/^https?:\/\//i.test(s)) return false; try { return !!new URL(s).hostname; } catch { return false; } };
export const resolveCtaLink = ({ evento, lead, brand }) => [evento, lead, brand].find(isUsableLink)?.trim() || '#';
export const formatBRL = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
// Valores das variáveis do modelo: cada posição aponta para um campo do lead ou é texto fixo.
export function resolveVars(map, { lead, ctaLink, brand }) {
  const fields = { nome: lead.nome || '', produto: lead.produto || 'seu pedido', valor: formatBRL(lead.valor_compra), cta_link: ctaLink, loja: brand?.nome || '', email: lead.email || '' };
  return (Array.isArray(map) ? map : []).map((m) => { const k = String(m).replace(/[{}\s]/g, ''); return k in fields ? fields[k] : String(m); });
}
export const retryable = (status, code) => code === 'not_connected' || NON_FATAL.has(status) || status >= 500 || status === undefined;

export function createEngine({ pool, whatsapp, now = () => Date.now() }) {
  async function condicaoAtendida(s, cond) {
    if (!cond || cond === 'sempre') return true;
    const { rows } = await pool.query(`select 1 from public.webhook_events where organization_id = $1 and lead_id = $2 and tipo_evento = 'Compra Aprovada' and created_at >= $3 limit 1`, [s.organization_id, s.lead_id, s.created_at]);
    return cond === 'comprou' ? rows.length > 0 : rows.length === 0;
  }
  const finalize = (id, attempts, err = null) => pool.query(`update public.scheduled_steps set status_agendamento = 'Finalizado', attempts = $2, last_error = $3, updated_at = now() where id = $1`, [id, attempts, err]);
  async function failStep(id, cur, err) {
    const attempts = cur + 1;
    if (attempts >= MAX_ATTEMPTS) { await finalize(id, attempts, err); return 'gaveup'; }
    await pool.query(`update public.scheduled_steps set status_agendamento = 'Em andamento', attempts = $2, last_error = $3, run_at = $4, updated_at = now() where id = $1`, [id, attempts, err, new Date(now() + RETRY_BACKOFF_MIN * 60000 * attempts).toISOString()]);
    return 'retry';
  }
  const reserve = (org) => pool.query(`select public.bulk_reserve_usage($1, 1) as ok`, [org]).then((r) => r.rows[0].ok !== false ? 'reserved' : 'denied').catch(() => 'error');
  const release = (org) => pool.query(`select public.scheduled_step_release_usage($1, 1)`, [org]).catch(() => {});

  async function claim() {
    const { rows } = await pool.query(`
      with due as (
        select ss.id from public.scheduled_steps ss join public.flow_steps fs on fs.id = ss.step_id
        where ss.status_agendamento in ('Iniciado','Em andamento') and ss.run_at <= now()
          and fs.tipo_card in ('Envio de WhatsApp','Adicionar Tag','Remover Tag')
        order by ss.run_at limit $1 for update of ss skip locked)
      update public.scheduled_steps s set run_at = now() + ($2 || ' minutes')::interval
      from due where s.id = due.id and s.run_at <= now() and s.status_agendamento in ('Iniciado','Em andamento') returning s.id, s.organization_id, s.lead_id, s.step_id, s.webhook_event_id, s.attempts, s.created_at`, [BATCH, String(LEASE_MIN)]);
    return rows;
  }

  async function runWhatsapp(s, step, lead, stats) {
    const cur = s.attempts;
    if (!step.whatsapp_message_id) { await finalize(s.id, cur + 1, 'etapa sem mensagem WhatsApp vinculada'); stats.failed++; return; }
    if (!lead || !lead.telefone) { await finalize(s.id, cur + 1, 'lead sem telefone'); stats.failed++; return; }
    if (lead.whatsapp_opt_out) { await finalize(s.id, cur + 1, 'pulado: lead pediu para não receber WhatsApp'); stats.skipped++; return; }
    if (!(await condicaoAtendida(s, step.condicao))) { await finalize(s.id, cur + 1, `pulado: condição '${step.condicao}' não atendida`); stats.skipped++; return; }
    const wm = (await pool.query(`select template_id, template_vars from public.whatsapp_messages where id = $1`, [step.whatsapp_message_id])).rows[0];
    if (!wm) { await finalize(s.id, cur + 1, 'mensagem de WhatsApp não encontrada'); stats.failed++; return; }
    if (!wm.template_id) { await finalize(s.id, cur + 1, 'mensagem sem modelo aprovado da Meta (escolha um modelo no passo)'); stats.failed++; return; }
    const tpl = (await pool.query(`select * from public.whatsapp_templates where id = $1 and organization_id = $2`, [wm.template_id, s.organization_id])).rows[0];
    if (!tpl) { await finalize(s.id, cur + 1, 'modelo da Meta não encontrado'); stats.failed++; return; }
    const ev = s.webhook_event_id ? (await pool.query(`select tipo_evento, checkout_url from public.webhook_events where id = $1`, [s.webhook_event_id])).rows[0] : null;
    const brand = (await pool.query(`select b.nome, b.link_loja from public.campaign_flows cf join public.campaigns c on c.id = cf.campaign_id
      left join public.brands b on b.id = coalesce(c.brand_id, (select id from public.brands where organization_id = c.organization_id order by ordem limit 1))
      where cf.id = $1`, [step.flow_id])).rows[0] || {};
    const ctaLink = resolveCtaLink({ evento: ev?.checkout_url, lead: lead.link_recuperacao, brand: brand.link_loja });
    const usaCta = (wm.template_vars || []).some((m) => /cta_link/.test(String(m)));
    if (usaCta && ev && EVENTOS_RECUPERACAO.has(ev.tipo_evento) && !isUsableLink(ctaLink)) { await finalize(s.id, cur + 1, PULADO_SEM_LINK); stats.skipped++; return; }
    // Botão de URL do modelo ({{1}}): o sufixo é o que vem depois do endereço fixo do botão.
    let suffix;
    const btn = ((tpl.components || []).find((c) => String(c.type).toUpperCase() === 'BUTTONS') || {}).buttons?.find((b) => String(b.type).toUpperCase() === 'URL' && /\{\{\s*1\s*\}\}/.test(b.url || ''));
    if (btn) { const prefix = btn.url.split('{{')[0]; suffix = ctaLink.startsWith(prefix) ? ctaLink.slice(prefix.length) : ''; }

    const campaignId = (await pool.query(`select campaign_id from public.campaign_flows where id = $1`, [step.flow_id])).rows[0]?.campaign_id || null;
    const reserved = (await reserve(s.organization_id)) === 'reserved';
    let ok = false, msgId = null, err = null, retry = false;
    try {
      const out = await whatsapp.sendTemplateTo(s.organization_id, { to: lead.telefone, template_id: tpl.id, variables: resolveVars(wm.template_vars, { lead, ctaLink, brand }), button_suffix: suffix });
      ok = true; msgId = out.id;
    } catch (e) { err = String(e.message || e).slice(0, 200); retry = retryable(e.status, e.code); }
    await pool.query(`insert into public.email_events (organization_id, campaign_id, event, channel, email, status, sg_message_id, reason, "timestamp") values ($1,$2,'send','whatsapp',$3,$4,$5,$6, now())`,
      [s.organization_id, campaignId, lead.email, ok ? 'enviado' : 'falhou', msgId, err]);
    if (ok) {
      const lm = await pool.query(`update public.lead_metrics set enviados = coalesce(enviados,0) + 1 where lead_id = $1 returning id`, [lead.id]);
      if (!lm.rowCount) await pool.query(`insert into public.lead_metrics (lead_id, organization_id, enviados) values ($1,$2,1)`, [lead.id, s.organization_id]);
      if (campaignId) {
        const cs = await pool.query(`update public.campaign_stats set whatsapp_enviados = coalesce(whatsapp_enviados,0) + 1, ultimo_calculo = now() where campaign_id = $1 returning id`, [campaignId]);
        if (!cs.rowCount) await pool.query(`insert into public.campaign_stats (campaign_id, organization_id, whatsapp_enviados, ultimo_calculo) values ($1,$2,1,now())`, [campaignId, s.organization_id]);
      }
      await finalize(s.id, cur + 1); stats.sent++;
    } else if (!retry) { await finalize(s.id, cur + 1, err); stats.failed++; if (reserved) await release(s.organization_id); }
    else { const r = await failStep(s.id, cur, err); if (r === 'gaveup' && reserved) await release(s.organization_id); r === 'gaveup' ? stats.gaveup++ : stats.retried++; stats.failed++; }
  }

  async function tick() {
    const stats = { claimed: 0, sent: 0, tagged: 0, failed: 0, retried: 0, gaveup: 0, skipped: 0 };
    const due = await claim(); stats.claimed = due.length;
    for (const s of due) {
      try {
        const step = (await pool.query(`select id, tipo_card, whatsapp_message_id, flow_id, condicao from public.flow_steps where id = $1`, [s.step_id])).rows[0];
        const lead = (await pool.query(`select id, email, nome, telefone, produto, valor_compra, link_recuperacao, whatsapp_opt_out from public.leads where id = $1`, [s.lead_id])).rows[0];
        if (!step) { await finalize(s.id, s.attempts + 1, 'passo removido'); continue; }
        if (step.tipo_card === 'Envio de WhatsApp') await runWhatsapp(s, step, lead, stats);
        else if (lead && step.tipo_card === 'Adicionar Tag') {
          await pool.query(`insert into public.lead_tags (lead_id, tag_id) select $1, tag_id from public.step_add_tags where step_id = $2 on conflict do nothing`, [lead.id, step.id]);
          await finalize(s.id, s.attempts + 1); stats.tagged++;
        } else if (lead && step.tipo_card === 'Remover Tag') {
          await pool.query(`delete from public.lead_tags where lead_id = $1 and tag_id in (select tag_id from public.step_remove_tags where step_id = $2)`, [lead.id, step.id]);
          await finalize(s.id, s.attempts + 1);
        } else await finalize(s.id, s.attempts + 1, lead ? null : 'lead removido');
      } catch (e) {
        console.error('[engine] passo', s.id, e.message);
        await failStep(s.id, s.attempts, String(e.message).slice(0, 200)).catch(() => {});
        stats.failed++;
      }
    }
    return stats;
  }
  return { tick };
}
