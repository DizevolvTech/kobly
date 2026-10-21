// Kobly — hidratação dos dados do Supabase no MESMO formato do mock (KoblyMockDB).
// Cada consulta é escopada automaticamente pela RLS multi-tenant conforme o usuário
// logado (persona do seletor de papéis). Assim o restante da camada de API (mockApi.js)
// reaproveita a lógica de síntese de gráficos sem mudanças.
// Reshape snake_case (Supabase) -> camelCase aninhado (contrato da UI). Cache por sessão.
import { supabase } from './supabaseClient.js';

// ---- formatadores ---------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const D = (s) => (s ? new Date(s) : null);
const num = (x) => Number(x) || 0;
export function fmtDate(s) { const d = D(s); return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : '—'; }
export function fmtDateTime(s) { const d = D(s); return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '—'; }
function fmtTime(s) { const d = D(s); return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; }
function fmtShort(s) { const d = D(s); return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '—'; }
function relTime(s) {
  const d = D(s); if (!d) return '';
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  const days = Math.round(h / 24);
  if (days === 1) return 'ontem';
  return fmtDate(s);
}

// ---- reshape de mensagem de suporte (usado no hydrate e pelo Realtime) -----
export function reshapeSupportMessage(m) {
  return {
    id: m.id, autor: m.autor, nome: m.nome, texto: m.mensagem,
    when: fmtTime(m.created_at), createdAt: m.created_at, profileId: m.profile_id || null,
    conversationId: m.conversation_id || null,
  };
}

// ---- reshape de etapa de fluxo (config por @TipoCardFluxo) -----------------
function reshapeStep(s, flowMap) {
  let config = {};
  if (s.tipo_card === 'Gatilho') config = { tipoEvento: s.tipo_evento, webhookId: s.webhook_id };
  else if (s.tipo_card === 'Adicionar Tag') config = { tags: (s.step_add_tags || []).map((t) => t.tag_id) };
  else if (s.tipo_card === 'Remover Tag') config = { tags: (s.step_remove_tags || []).map((t) => t.tag_id) };
  else if (s.tipo_card === 'Envio de e-mail') config = { emailId: s.email_id, condicao: s.condicao || null };
  else if (s.tipo_card === 'Envio de WhatsApp') config = { whatsappMessageId: s.whatsapp_message_id, condicao: s.condicao || null };
  else if (s.tipo_card === 'Envio de SMS') config = { smsMessageId: s.sms_message_id, condicao: s.condicao || null };
  else if (s.tipo_card === 'Condição') config = { condTipo: 'comprou' }; // v1: única condição
  else if (s.tipo_card === 'Acionar Fluxo') config = { fluxoAlvo: flowMap[s.fluxo_alvo_id] || s.fluxo_alvo_id };
  // parentId/ramo reconstroem a árvore de ramos do card Condição no builder.
  return { id: s.id, tipo: s.tipo_card, nome: s.nome, posicao: s.posicao, atraso: num(s.atraso), config, parentId: s.parent_step_id || null, ramo: s.ramo || null };
}

function reshapeStats(cs) {
  // FK único (campaign_id) -> PostgREST devolve 1:1 como OBJETO; aceita objeto ou array.
  const r = Array.isArray(cs) ? cs[0] : cs;
  if (!r) return { taxaAbertura: 0, ctr: 0, emailsEnviados: 0, vendasRecuperadas: 0, criticidade: 'Não Iniciado', valorCriticidade: 0, ultimoCalculo: '—' };
  return {
    taxaAbertura: num(r.taxa_abertura), ctr: num(r.ctr), emailsEnviados: num(r.emails_enviados),
    vendasRecuperadas: num(r.vendas_recuperadas), criticidade: r.status_criticidade,
    valorCriticidade: num(r.valor_criticidade), ultimoCalculo: r.ultimo_calculo ? fmtDateTime(r.ultimo_calculo) : '—',
  };
}

// ---- cache por sessão ------------------------------------------------------
let _cache = null;
let _inflight = null;
export function resetDb() { _cache = null; _inflight = null; }

async function sel(table, columns, order) {
  let q = supabase.from(table).select(columns);
  if (order) q = q.order(order);
  const { data, error } = await q;
  if (error) { console.error(`[supabaseDb] ${table}:`, error.message); return []; }
  return data || [];
}

async function hydrate() {
  const [orgs, profiles, plans, templates, tags, emails, whatsappMsgs, smsMsgs, domains, webhooks, postbackTokens, brands, leads, campaigns, events, convs, txs, access, sessions, faq] = await Promise.all([
    sel('organizations', '*'),
    sel('profiles', '*'),
    sel('plans', '*'),
    sel('templates', '*'),
    sel('tags', '*'),
    sel('emails', '*'),
    sel('whatsapp_messages', '*'),
    sel('sms_messages', '*'),
    sel('domains', '*, domain_dns_records(*)'),
    sel('webhooks', '*, webhook_event_types(tipo_evento)'),
    // WEB-1: tokens de postback nomeados (webhooks por produto/plataforma).
    sel('postback_tokens', '*', 'created_at'),
    // MARCA-1: marcas/produtos por org (1:N) — substitui org_branding (1:1).
    sel('brands', '*', 'ordem'),
    sel('leads', '*, lead_tags(tag_id), lead_metrics(enviados, aberturas, cliques)'),
    // flow_steps tem 2 FKs p/ campaign_flows (flow_id e fluxo_alvo_id) -> desambigua via !flow_id
    // (o "*" de flow_steps já inclui email_id e whatsapp_message_id)
    sel('campaigns', '*, campaign_stats(*), campaign_flows(id, campaign_id, flow_steps!flow_id(*, step_add_tags(tag_id), step_remove_tags(tag_id)), flow_meta_tags(tag_id))'),
    sel('webhook_events', '*'),
    sel('support_conversations', '*, support_messages(*)'),
    sel('transactions', '*'),
    sel('access_logs', '*'),
    sel('active_sessions', '*'),
    sel('faq', '*', 'ordem'),
  ]);

  // UX-3: campanhas mais recentes no topo da listagem. O select de campaigns
  // acima não ordena (vem em ordem natural do banco); ordenamos por created_at
  // desc aqui para que toda a UI (lista, dashboard, relatórios) mostre as
  // campanhas recém-criadas primeiro. Cópia para não mutar o array da query.
  const campaignsRecent = campaigns.slice().sort(
    (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)
  );

  // maps de nome
  const orgMap = Object.fromEntries(orgs.map((o) => [o.id, o.nome]));
  const profMap = Object.fromEntries(profiles.map((p) => [p.id, p.nome]));
  const campMap = Object.fromEntries(campaigns.map((c) => [c.id, c.nome]));
  // campaign_flows é 1:1 (campaign_id único) -> PostgREST devolve objeto, não array.
  const flowOf = (c) => (Array.isArray(c.campaign_flows) ? c.campaign_flows[0] : c.campaign_flows) || null;
  // flowId -> campaignId (p/ "Acionar Fluxo")
  const flowMap = {};
  campaigns.forEach((c) => { const f = flowOf(c); if (f) flowMap[f.id] = f.campaign_id; });

  return {
    empresas: orgs.map((o) => ({
      id: o.id, nome: o.nome, fundadorId: o.user_fundador_id, segmento: o.segmento, planoId: o.plano_id,
      leads: num(o.leads_count), campanhasAtivas: num(o.campanhas_ativas_count), criticidade: o.criticidade,
      // CPF/CNPJ normalizado (sem máscara). Vai para o Asaas como cpfCnpj. Ver src/lib/documento.js.
      documento: o.documento || '',
    })),
    users: profiles.map((p) => ({
      id: p.id, nome: p.nome, email: p.email, tipo: p.tipo_user_geral, status: p.status_user,
      celular: p.celular, local: p.local, ultimoLogin: p.ultimo_login ? fmtDateTime(p.ultimo_login) : '—',
      perfilCompleto: p.perfil_completo, empresaId: p.organization_id,
    })),
    planos: plans.map((pl) => ({
      id: pl.id, nome: pl.nome, descricao: pl.descricao, status: pl.status, valorMensal: num(pl.valor_mensal),
      valorAnual: num(pl.valor_anual), limiteCampanhas: num(pl.limite_campanhas), limiteExecucoes: num(pl.limite_execucoes), deleted: pl.deleted,
      valorSemestral: num(pl.valor_semestral), limiteIntegracoes: num(pl.limite_integracoes),
      precoExcedente: num(pl.preco_excedente),
      smsHabilitado: !!pl.sms_habilitado, disparoMassaHabilitado: !!pl.disparo_massa_habilitado,
      dominioProprioHabilitado: !!pl.dominio_proprio_habilitado,
    })),
    templates: templates.map((t) => ({
      id: t.id, tipo: t.tipo_template, nome: t.nome, icone: t.icone, descricao: t.descricao, blank: t.blank, gatilho: t.gatilho,
    })),
    tags: tags.map((t) => ({ id: t.id, nome: t.nome, descricao: t.descricao, tipoEvento: t.tipo_evento, empresaId: t.organization_id })),
    emails: emails.map((e) => ({ id: e.id, titulo: e.titulo, assunto: e.assunto, remetente: e.remetente, dominioId: e.dominio_id, corpoHtml: e.corpo_html })),
    whatsappMessages: whatsappMsgs.map((m) => ({
      id: m.id, titulo: m.titulo, corpoTexto: m.corpo_texto, mediaUrl: m.media_url, templateId: m.template_id || null, templateVars: Array.isArray(m.template_vars) ? m.template_vars : [],
      botoes: Array.isArray(m.botoes) ? m.botoes : [],
      empresaId: m.organization_id,
    })),
    // SMS (GTI SMS) — templates por org (espelha whatsappMessages).
    smsMessages: smsMsgs.map((m) => ({ id: m.id, titulo: m.titulo, corpoTexto: m.corpo_texto, empresaId: m.organization_id })),
    // WEB-1: webhooks nomeados (tokens de postback) — usados no seletor de
    // webhook do FlowBuilder e no CRUD da aba Integrações.
    postbackTokens: postbackTokens.map((t) => ({ id: t.id, nome: t.nome, token: t.token, ativo: t.ativo, empresaId: t.organization_id, criadoEm: fmtDate(t.created_at) })),
    // MARCA-1: marcas/produtos por org (1:N). Substitui org_branding (1:1).
    brands: brands.map((b) => ({ id: b.id, nome: b.nome, logoUrl: b.logo_url, cor: b.cor, modo: b.modo, linkLoja: b.link_loja, empresaId: b.organization_id })),
    dominios: domains.map((d) => ({
      id: d.id, url: d.url, validado: d.validado, idSendGrid: d.id_sendgrid || d.id_resend,
      idResend: d.id_resend || d.id_sendgrid, fromEmail: d.from_email, status: d.status || (d.validado ? 'verified' : 'pending'),
      empresaId: d.organization_id,
      registros: (d.domain_dns_records || []).map((r) => ({ tipo: r.tipo, host: r.host, valor: r.valor, status: r.status, role: r.record_role })),
    })),
    webhooks: webhooks.map((w) => ({
      id: w.id, nome: w.nome, descricao: w.descricao, url: w.url, secret: w.secret, testado: w.testado,
      provider: w.provider, desabilitado: w.desabilitado, eventos: (w.webhook_event_types || []).map((e) => e.tipo_evento),
    })),
    leads: leads.map((l) => {
      const m = (l.lead_metrics || []).reduce((a, x) => ({ enviados: a.enviados + num(x.enviados), aberturas: a.aberturas + num(x.aberturas), cliques: a.cliques + num(x.cliques) }), { enviados: 0, aberturas: 0, cliques: 0 });
      return {
        id: l.id, empresaId: l.organization_id, nome: l.nome, sobrenome: l.sobrenome, email: l.email,
        telefone: l.telefone, produto: l.produto, valorCompra: num(l.valor_compra), metodoPagamento: l.metodo_pagamento,
        pixGerado: l.pix_gerado, ultimoEvento: l.ultimo_evento, tags: (l.lead_tags || []).map((t) => t.tag_id),
        criadoEm: fmtDate(l.created_at), metricas: m,
      };
    }),
    campanhas: campaignsRecent.map((c) => {
      const flow = flowOf(c);
      const steps = ((flow && flow.flow_steps) || []).slice().sort((a, b) => a.posicao - b.posicao);
      return {
        id: c.id, empresaId: c.organization_id, nome: c.nome, status: c.status_campanha, usaTemplate: c.usa_template,
        templateId: c.template_id, criadorId: c.criador_id, criadoEm: fmtDate(c.created_at), postbackTokenId: c.postback_token_id || null, brandId: c.brand_id || null,
        stats: reshapeStats(c.campaign_stats),
        tagsMeta: ((flow && flow.flow_meta_tags) || []).map((t) => t.tag_id),
        fluxo: steps.map((s) => reshapeStep(s, flowMap)),
      };
    }),
    webhookEvents: events.map((e) => ({
      id: e.id, empresaId: e.organization_id, provider: e.provider, tipoEvento: e.tipo_evento, email: e.email,
      produto: e.produto, valor: num(e.valor_produto), when: relTime(e.created_at), campanha: campMap[e.campaign_id] || '',
    })),
    conversas: convs.map((c) => ({
      id: c.id, clienteId: c.cliente_id, clienteNome: profMap[c.cliente_id] || '', empresa: orgMap[c.organization_id] || '',
      empresaId: c.organization_id,
      assignedTo: c.assigned_to || null, assignedToNome: profMap[c.assigned_to] || null,
      origem: c.origem || 'manual',
      clienteLastReadAt: c.cliente_last_read_at || null, supportLastReadAt: c.support_last_read_at || null,
      tipo: c.tipo_chamado, status: c.status_chamado, prioridade: c.prioridade_chamado,
      atualizadoEm: relTime(c.updated_at), updatedAtIso: c.updated_at,
      assunto: c.assunto,
      mensagens: (c.support_messages || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map(reshapeSupportMessage),
    })),
    transacoes: txs.map((t) => ({
      id: t.id, userId: t.profile_id, planoId: t.plano_id, valorPago: num(t.valor_pago), formaPagamento: t.forma_pagamento,
      status: t.status_pagamento, idTransacao: t.id_transacao, data: fmtDate(t.data),
    })),
    historicoAcesso: access.map((a) => ({
      id: a.id, userId: a.profile_id, nome: a.nome, ip: a.ip_conexao, local: a.local, tipoLog: a.tipo_log, when: fmtShort(a.created_at),
    })),
    sessoesAtivas: sessions.map((s) => ({
      id: s.id, userId: s.profile_id, nome: profMap[s.profile_id] || '', dispositivo: s.dispositivo, ip: s.ip_conexao, when: relTime(s.last_seen_at),
    })),
    faq: faq.map((f) => ({ q: f.pergunta, a: f.resposta })),
  };
}

// loadDB — hidrata (com cache por sessão; de-dup de chamadas concorrentes).
export async function loadDB() {
  if (_cache) return _cache;
  if (_inflight) return _inflight;
  _inflight = hydrate().then((db) => { _cache = db; _inflight = null; return db; }).catch((e) => { _inflight = null; throw e; });
  return _inflight;
}

// Perfil do usuário autenticado atual (p/ writes e sessão).
export async function currentProfile() {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth || !auth.user) return null;
  const { data, error } = await supabase.from('profiles').select('*').eq('auth_id', auth.user.id).maybeSingle();
  if (error) { console.error('[supabaseDb] currentProfile:', error.message); return null; }
  return data;
}

// Primeira org acessível ao usuário (própria ou gerida) — p/ escopo de writes.
export async function firstOrgId(profile) {
  if (profile && profile.organization_id) return profile.organization_id;
  const { data } = await supabase.from('organizations').select('id').limit(1);
  return data && data[0] ? data[0].id : null;
}
