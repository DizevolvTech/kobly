// Kobly — camada de API (Supabase). Mantém a assinatura `KoblyApi` (contrato da UI):
// a UI depende só destas assinaturas async. Antes lia de um mock em memória; agora lê
// do Supabase via loadDB() (escopado por RLS multi-tenant) e escreve via supabase-js.
// Toda a SÍNTESE de séries/gráficos foi preservada — só a FONTE dos dados mudou.
import { supabase, SUPABASE_URL } from './supabaseClient.js';
import { loadDB, resetDb, currentProfile, firstOrgId, fmtDate, fmtDateTime } from './supabaseDb.js';
import { renderEmail } from '../lib/emailTemplate.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const br = (n) => Number(n).toLocaleString('pt-BR');
const pct = (n) => (n * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
const money = (n) => 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function asaasErrorMessage(value, fallback = 'Falha ao processar a cobrança no Asaas.') {
  if (typeof value === 'string' && value) return value;
  if (!value || typeof value !== 'object') return fallback;
  const first = Array.isArray(value.errors) ? value.errors[0] : null;
  return first?.description || first?.code || value.message || value.detail || JSON.stringify(value);
}

// helpers de lookup (recebem o db hidratado)
const empresaNome = (db, id) => (db.empresas.find((e) => e.id === id) || {}).nome || '—';
const userById = (db, id) => db.users.find((u) => u.id === id) || {};
const planoById = (db, id) => db.planos.find((p) => p.id === id) || {};

// ---- Eixo temporal (dias reais do período) ---------------------------------
// Chaves ISO (YYYY-MM-DD) + rótulos curtos (D/M) para agrupar eventos por dia.
function dayAxis(days) {
  const keys = []; const labels = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    keys.push(d.toISOString().slice(0, 10));
    labels.push(`${d.getDate()}/${d.getMonth() + 1}`);
  }
  return { keys, labels };
}

// ---- Sessão derivada do perfil autenticado --------------------------------
function buildSession(profile, db) {
  const role = profile.tipo_user_geral;
  const org = db.empresas.find((e) => e.id === profile.organization_id);
  const plano = org ? (db.planos.find((p) => p.id === org.planoId) || {}).nome : undefined;
  const contextLabel = (org && org.nome) || role;
  return { userId: profile.id, empresaId: profile.organization_id, contextLabel, role, name: profile.nome, email: profile.email, plano };
}

export const KoblyApi = {
  br, pct, money,

  // ---- Autenticação (login real) ------------------------------------------
  // Login por e-mail/senha. O store reage via onAuthStateChange e hidrata a sessão.
  async signIn(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email: (email || '').trim(), password });
    if (!error) resetDb();
    return { error: error ? error.message : null };
  },
  // Atalho de demonstração (DEV-only): entra como a persona do papel. O import
  // dinâmico sob o guard mantém as credenciais demo fora do bundle de produção.
  async signInAsRole(role) {
    if (!import.meta.env.DEV) return { error: 'Disponível apenas em desenvolvimento' };
    const { DEMO_PERSONAS, DEMO_PASSWORD } = await import('./demoPersonas.js');
    const persona = DEMO_PERSONAS[role];
    if (!persona) return { error: 'Papel desconhecido: ' + role };
    return this.signIn(persona.email, DEMO_PASSWORD);
  },
  async signUp(email, password, nome) {
    // EMAIL-3: emailRedirectTo garante que o link de confirmação volte para a
    // origem correta (dev: localhost:5173 / prod: domínio do app), e não para o
    // Site URL padrão do Supabase (que pode estar como localhost:3000). O domínio
    // precisa estar na allowlist de Redirect URLs no dashboard do Auth.
    const redirectTo = (typeof window !== 'undefined') ? window.location.origin : undefined;
    const { data, error } = await supabase.auth.signUp({
      email: (email || '').trim(), password,
      options: { data: { nome: nome || '' }, ...(redirectTo ? { emailRedirectTo: redirectTo } : {}) },
    });
    if (error) return { error: error.message };
    if (data && data.session) resetDb();
    // sem session => o projeto exige confirmação de e-mail
    return { error: null, needsConfirmation: !(data && data.session) };
  },
  async resetPassword(email) {
    const redirectTo = (typeof window !== 'undefined') ? window.location.origin : undefined;
    const { error } = await supabase.auth.resetPasswordForEmail((email || '').trim(), { redirectTo });
    return { error: error ? error.message : null };
  },
  async updatePassword(newPassword) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    return { error: error ? error.message : null };
  },
  // Constrói a sessão do app a partir do usuário autenticado atual (ou null).
  async loadAppSession() {
    const profile = await currentProfile();
    if (!profile) return null;
    // Usuário desabilitado pelo Admin não entra: encerra a sessão de auth na hora.
    if (profile.status_user === 'Desabilitado') {
      await supabase.auth.signOut();
      resetDb();
      return null;
    }
    const db = await loadDB();
    return buildSession(profile, db);
  },
  async getSession() { return this.loadAppSession(); },
  async signOut() { await supabase.auth.signOut(); resetDb(); return true; },

  // ---- Campanhas ----------------------------------------------------------
  async listCampaigns() {
    const db = await loadDB();
    return { campaigns: clone(db.campanhas), templates: clone(db.templates) };
  },
  async getCampaign(id) {
    const db = await loadDB();
    const c = db.campanhas.find((x) => x.id === id);
    return c ? clone(c) : null;
  },
  async createCampaign(tpl, empresaId, nome, brandId) {
    const me = await currentProfile();
    const orgId = empresaId || await firstOrgId(me);
    if (!orgId) throw new Error('Sua conta ainda não tem organização configurada.');
    const finalNome = (nome && nome.trim()) || (tpl.blank ? 'Nova campanha' : tpl.nome);
    const { data: camp, error } = await supabase.from('campaigns').insert({
      organization_id: orgId, nome: finalNome, status_campanha: 'Rascunho',
      usa_template: !tpl.blank, template_id: tpl.blank ? null : tpl.id, criador_id: me ? me.id : null,
      brand_id: brandId || null,
    }).select().single();
    if (error) throw error;
    const { data: flow } = await supabase.from('campaign_flows').insert({ campaign_id: camp.id, organization_id: orgId }).select().single();
    const fluxo = [];
    if (tpl.gatilho && flow) {
      const { data: st } = await supabase.from('flow_steps').insert({
        flow_id: flow.id, organization_id: orgId, tipo_card: 'Gatilho', nome: tpl.gatilho, posicao: 0, atraso: 0, tipo_evento: tpl.gatilho,
      }).select().single();
      if (st) fluxo.push({ id: st.id, tipo: 'Gatilho', nome: tpl.gatilho, posicao: 0, atraso: 0, config: { tipoEvento: tpl.gatilho, webhookId: null } });
    }
    await supabase.from('campaign_stats').insert({ campaign_id: camp.id, organization_id: orgId });
    resetDb();
    return {
      id: camp.id, empresaId: orgId, nome: camp.nome, status: 'Rascunho', usaTemplate: !tpl.blank, templateId: tpl.blank ? null : tpl.id,
      brandId: brandId || null, criadorId: me ? me.id : null, criadoEm: fmtDate(camp.created_at),
      stats: { taxaAbertura: 0, ctr: 0, emailsEnviados: 0, vendasRecuperadas: 0, criticidade: 'Não Iniciado', valorCriticidade: 0, ultimoCalculo: '—' },
      tagsMeta: [], fluxo,
    };
  },
  async setCampaignStatus(id, status) {
    const { error } = await supabase.from('campaigns').update({ status_campanha: status }).eq('id', id);
    resetDb();
    return !error;
  },
  // Exclui campanha (cascade: flow, stats, steps via FKs do schema).
  async deleteCampaign(id) {
    if (!id) return { error: 'ID ausente' };
    const { error } = await supabase.from('campaigns').delete().eq('id', id);
    resetDb();
    return { error: error ? error.message : null };
  },

  // Cria uma campanha COMPLETA a partir de um plano gerado por IA:
  // Gatilho (plan.gatilho) + N e-mails (etapas com atraso, assunto e corpo renderizado na marca).
  async createCampaignFromPlan(plan, empresaId, brandId) {
    const me = await currentProfile();
    const orgId = empresaId || await firstOrgId(me);
    if (!plan) return null;
    if (!orgId) throw new Error('Sua conta ainda não tem organização configurada.');
    // MARCA-1: marca white-label p/ renderizar os e-mails — usa a marca selecionada
    // (brands.id) ou, na falta, a 1ª marca da org.
    let brand = { name: 'Sua Loja' };
    try {
      let bq = supabase.from('brands').select('nome, logo_url, cor, modo').eq('organization_id', orgId);
      bq = brandId ? bq.eq('id', brandId) : bq.order('ordem').limit(1);
      const { data: b } = await bq.maybeSingle();
      if (b) brand = { name: b.nome || 'Sua Loja', logoUrl: b.logo_url || undefined, color: b.cor || undefined, mode: b.modo || 'dark' };
    } catch (e) { /* usa default */ }

    const { data: camp, error } = await supabase.from('campaigns').insert({
      organization_id: orgId, nome: plan.nome || 'Campanha (IA)', status_campanha: 'Rascunho', usa_template: false, criador_id: me ? me.id : null,
      brand_id: brandId || null,
    }).select().single();
    if (error) throw error;
    const { data: flow } = await supabase.from('campaign_flows').insert({ campaign_id: camp.id, organization_id: orgId }).select().single();
    await supabase.from('campaign_stats').insert({ campaign_id: camp.id, organization_id: orgId });

    const fluxo = [];
    const gatilho = plan.gatilho || 'Abandono de carrinho';
    const { data: gat } = await supabase.from('flow_steps').insert({
      flow_id: flow.id, organization_id: orgId, tipo_card: 'Gatilho', nome: gatilho, posicao: 0, atraso: 0, tipo_evento: gatilho,
    }).select().single();
    if (gat) fluxo.push({ id: gat.id, tipo: 'Gatilho', nome: gatilho, posicao: 0, atraso: 0, config: { tipoEvento: gatilho, webhookId: null } });

    let pos = 1;
    for (const et of (plan.etapas || [])) {
      const atraso = Number(et.atraso_min) || 0;
      // Condição de envio (IF/ELSE do fluxo) — só valores válidos; o resto vira "sempre" (null).
      const condicao = ['comprou', 'nao_comprou'].includes(et.condicao) ? et.condicao : null;

      // Etapa de WhatsApp (plan.etapas[].canal === 'whatsapp'): cria a mensagem em
      // whatsapp_messages e o card 'Envio de WhatsApp' — espelha o caminho do e-mail.
      if (et.canal === 'whatsapp') {
        let texto = String(et.texto || '').trim() || `Oi! Aqui é a ${brand.name}. Seus itens ainda estão reservados. 😉\nFinalize por aqui: {{cta_link}}`;
        // Normaliza variantes malformadas do placeholder que a IA às vezes gera
        // ({cta_link}, {{cta_link} …) e garante que ele exista — sem ele a mensagem
        // sai sem o link de recuperação.
        texto = texto.replace(/\{{1,2}\s*cta_link\s*\}{1,2}/gi, '{{cta_link}}');
        if (!texto.includes('{{cta_link}}')) texto = `${texto}\n\n{{cta_link}}`;
        const tituloWa = et.titulo || et.assunto || 'Mensagem WhatsApp';
        const { data: wm } = await supabase.from('whatsapp_messages').insert({
          organization_id: orgId, titulo: tituloWa, corpo_texto: texto, created_by: me ? me.id : null,
        }).select().single();
        const { data: st } = await supabase.from('flow_steps').insert({
          flow_id: flow.id, organization_id: orgId, tipo_card: 'Envio de WhatsApp', nome: tituloWa, posicao: pos, atraso, whatsapp_message_id: wm ? wm.id : null, condicao,
        }).select().single();
        if (st) fluxo.push({ id: st.id, tipo: 'Envio de WhatsApp', nome: tituloWa, posicao: pos, atraso, config: { whatsappMessageId: wm ? wm.id : null, condicao } });
        pos += 1;
        continue;
      }

      const blocks = [
        { type: 'hero', eyebrow: et.eyebrow || 'Sua loja', title: et.titulo || et.assunto || 'Você esqueceu algo', text: (et.paragrafos || [])[0] || '' },
        ...((et.paragrafos || []).slice(1).map((p) => ({ type: 'paragraph', text: p }))),
        ...((et.cupom && et.cupom.codigo) ? [{ type: 'coupon', code: et.cupom.codigo, detail: et.cupom.detalhe || '' }] : []),
        // {{cta_link}}: token trocado no envio pelo link de recuperação do lead (process-steps).
        { type: 'button', label: et.cta || 'Concluir compra', href: '{{cta_link}}' },
      ];
      const html = renderEmail({ brand, preheader: et.assunto || '', blocks });
      const { data: em } = await supabase.from('emails').insert({
        organization_id: orgId, titulo: et.assunto || 'E-mail da campanha', assunto: et.assunto || '', corpo_html: html, remetente: brand.name,
      }).select().single();
      const { data: st } = await supabase.from('flow_steps').insert({
        flow_id: flow.id, organization_id: orgId, tipo_card: 'Envio de e-mail', nome: et.assunto || 'Envio de e-mail', posicao: pos, atraso, email_id: em ? em.id : null, condicao,
      }).select().single();
      if (st) fluxo.push({ id: st.id, tipo: 'Envio de e-mail', nome: et.assunto || 'Envio de e-mail', posicao: pos, atraso, config: { emailId: em ? em.id : null, condicao } });
      pos += 1;
    }

    resetDb();
    return {
      id: camp.id, empresaId: orgId, nome: camp.nome, status: 'Rascunho', usaTemplate: false, templateId: null,
      brandId: brandId || null, criadorId: me ? me.id : null, criadoEm: fmtDate(camp.created_at),
      stats: { taxaAbertura: 0, ctr: 0, emailsEnviados: 0, vendasRecuperadas: 0, criticidade: 'Não Iniciado', valorCriticidade: 0, ultimoCalculo: '—' },
      tagsMeta: [], fluxo,
    };
  },
  async renameCampaign(id, nome) {
    const { error } = await supabase.from('campaigns').update({ nome }).eq('id', id);
    resetDb();
    return !error;
  },
  // Retorna { ok, idMap } — idMap mapeia id do builder → id no banco (identidade p/ steps
  // existentes, id novo p/ inseridos). O FlowBuilder aplica esse map ao estado local pra
  // que um 2º save consecutivo (sem reload) veja os steps como EXISTENTES e faça UPDATE
  // in-place — senão recriaria os steps novos e apagaria os antigos (com a fila junto).
  async saveFlow(id, fluxo, tagsMeta) {
    const { data: flowRow } = await supabase.from('campaign_flows').select('id, organization_id').eq('campaign_id', id).maybeSingle();
    if (!flowRow) return { ok: false };
    const flowId = flowRow.id; const orgId = flowRow.organization_id;

    // BUG CRÍTICO (fila): NÃO apagar+recriar todos os steps a cada save. O delete-all
    // trocava o id de cada flow_step, e o ON DELETE CASCADE de scheduled_steps (0005)
    // ZERAVA a fila de mensagens pendentes de campanhas Ativas — leads no meio da
    // cadência paravam de receber os envios restantes. Correção: upsert por id ESTÁVEL.
    // Step existente → UPDATE in-place (mantém o id → a fila referenciada sobrevive);
    // step novo → INSERT; step removido do builder → DELETE (aí o cascade é correto).
    const { data: existingRows, error: exErr } = await supabase.from('flow_steps').select('id').eq('flow_id', flowId);
    if (exErr) { console.error('saveFlow: falha ao ler steps existentes', exErr); return { ok: false }; }
    const existing = new Set((existingRows || []).map((r) => r.id));

    const arr = fluxo || [];
    const idMap = {}; // id do builder → id no banco (p/ parent_step_id dos ramos)
    // Steps já persistidos mantêm o próprio id (identidade) — resolve parents na 2ª passada.
    arr.forEach((s) => { if (existing.has(s.id)) idMap[s.id] = s.id; });

    // Sincroniza os links de tag de um step (Adicionar/Remover Tag): delete+insert
    // (step_add_tags/step_remove_tags não são referenciados por scheduled_steps).
    const syncStepTags = async (s, stepId) => {
      const tags = (s.config || {}).tags || [];
      if (s.tipo === 'Adicionar Tag') {
        await supabase.from('step_add_tags').delete().eq('step_id', stepId);
        if (tags.length) await supabase.from('step_add_tags').insert(tags.map((t) => ({ step_id: stepId, tag_id: t })));
      } else if (s.tipo === 'Remover Tag') {
        await supabase.from('step_remove_tags').delete().eq('step_id', stepId);
        if (tags.length) await supabase.from('step_remove_tags').insert(tags.map((t) => ({ step_id: stepId, tag_id: t })));
      }
    };

    const upsertStep = async (s, i) => {
      const cfg = s.config || {};
      let fluxoAlvoId = null;
      if (s.tipo === 'Acionar Fluxo' && cfg.fluxoAlvo) {
        const { data: tf } = await supabase.from('campaign_flows').select('id').eq('campaign_id', cfg.fluxoAlvo).maybeSingle();
        fluxoAlvoId = tf ? tf.id : null;
      }
      // Ramo do card Condição COMPILA a condição do filho ('sim' → comprou,
      // 'nao' → nao_comprou) — o motor só conhece flow_steps.condicao (0022);
      // parent/ramo servem pra redesenhar a árvore no builder. Steps raiz usam
      // a condição própria do card (cfg.condicao).
      const condicao = s.parentId
        ? (s.ramo === 'sim' ? 'comprou' : 'nao_comprou')
        : (cfg.condicao || null);
      const parentDbId = s.parentId ? (idMap[s.parentId] || null) : null;
      const row = {
        flow_id: flowId, organization_id: orgId, tipo_card: s.tipo, nome: s.nome,
        // posicao = ordem do ARRAY do builder (fonte da verdade da ordem visual;
        // s.posicao antigo fica stale depois de drag/reorder).
        posicao: i, atraso: s.atraso || 0,
        email_id: cfg.emailId || null, whatsapp_message_id: cfg.whatsappMessageId || null,
        sms_message_id: cfg.smsMessageId || null,
        condicao,
        parent_step_id: parentDbId, ramo: parentDbId ? (s.ramo || null) : null,
        tipo_evento: cfg.tipoEvento || null, webhook_id: cfg.webhookId || null, fluxo_alvo_id: fluxoAlvoId,
      };
      if (existing.has(s.id)) {
        // UPDATE in-place preserva o id → scheduled_steps que apontam para este step sobrevivem.
        const { error } = await supabase.from('flow_steps').update(row).eq('id', s.id);
        if (error) { console.error('saveFlow update falhou', error); return false; }
        await syncStepTags(s, s.id);
        return true;
      }
      const { data: st, error } = await supabase.from('flow_steps').insert(row).select('id').single();
      if (error) { console.error('saveFlow insert falhou', error); return false; }
      idMap[s.id] = st.id;
      await syncStepTags(s, st.id);
      return true;
    };

    // Duas passadas: raiz primeiro (os filhos dos ramos referenciam o id do pai —
    // o card Condição pode estar DEPOIS dos filhos no array após um drag).
    for (let i = 0; i < arr.length; i++) if (!arr[i].parentId) { if (!(await upsertStep(arr[i], i))) return { ok: false }; }
    for (let i = 0; i < arr.length; i++) if (arr[i].parentId) { if (!(await upsertStep(arr[i], i))) return { ok: false }; }

    // Só depois de TODOS os upserts terem dado certo removemos os steps que saíram
    // do builder. Se um upsert falha acima, retornamos sem deletar nada — a fila
    // antiga fica intacta. Aqui o cascade de scheduled_steps é o comportamento certo.
    const keptIds = new Set(arr.filter((s) => existing.has(s.id)).map((s) => s.id));
    const toDelete = [...existing].filter((eid) => !keptIds.has(eid));
    if (toDelete.length) await supabase.from('flow_steps').delete().eq('flow_id', flowId).in('id', toDelete);

    // meta tags: reconcilia (não referenciadas por scheduled_steps — delete+insert é seguro).
    await supabase.from('flow_meta_tags').delete().eq('flow_id', flowId);
    if ((tagsMeta || []).length) await supabase.from('flow_meta_tags').insert(tagsMeta.map((t) => ({ flow_id: flowId, tag_id: t })));

    resetDb();
    return { ok: true, idMap };
  },

  // ---- Leads --------------------------------------------------------------
  async listLeads() {
    const db = await loadDB();
    const rows = clone(db.leads);
    // Contagens REAIS do pipeline de e-mail, escopadas por RLS às orgs acessíveis.
    const countOf = async (builder) => { const { count } = await builder; return count || 0; };
    // event='send' exclui os cliques em "Enviar teste" (event='send_test') — sem este
    // filtro cada teste manual infla enviados/rejeitados/processados do cliente.
    const [enviados, rejeitados, fila] = await Promise.all([
      countOf(supabase.from('email_events').select('id', { count: 'exact', head: true }).eq('event', 'send').eq('status', 'enviado')),
      countOf(supabase.from('email_events').select('id', { count: 'exact', head: true }).eq('event', 'send').eq('status', 'falhou')),
      countOf(supabase.from('scheduled_steps').select('id', { count: 'exact', head: true }).in('status_agendamento', ['Iniciado', 'Em andamento'])),
    ]);
    const status = {
      processados: enviados + rejeitados, // total de tentativas processadas (enviadas + rejeitadas)
      enviados,                           // email_events.event = 'send' e status = 'enviado'
      rejeitados,                         // email_events.event = 'send' e status = 'falhou'
      adiados: fila,                      // scheduled_steps ainda pendentes (na fila)
    };
    return { rows, status, tags: clone(db.tags) };
  },

  // Funil de recuperação — contagens REAIS por etapa, escopadas por RLS (opcionalmente
  // filtradas por empresaId). Etapas: eventos recebidos → e-mails enviados → abertos →
  // clicados → recuperados. Abertos/clicados = e-mails ÚNICOS (por destinatário).
  async getFunnel(empresaId) {
    const scope = (q) => (empresaId ? q.eq('organization_id', empresaId) : q);
    const countOf = async (builder) => { const { count } = await builder; return count || 0; };
    const uniqueEmails = async (ev) => {
      let q = supabase.from('email_events').select('email').eq('event', ev);
      if (empresaId) q = q.eq('organization_id', empresaId);
      const { data } = await q;
      return new Set((data || []).map((r) => r.email)).size;
    };
    const [eventos, enviados] = await Promise.all([
      countOf(scope(supabase.from('webhook_events').select('id', { count: 'exact', head: true }))),
      // event='send' exclui 'send_test' (botão "Enviar teste") do funil de campanha.
      countOf(scope(supabase.from('email_events').select('id', { count: 'exact', head: true }).eq('event', 'send').eq('status', 'enviado'))),
    ]);
    const [abertos, clicados] = await Promise.all([uniqueEmails('open'), uniqueEmails('click')]);
    let rq = supabase.from('campaign_stats').select('vendas_recuperadas');
    if (empresaId) rq = rq.eq('organization_id', empresaId);
    const { data: cs } = await rq;
    const recuperados = (cs || []).reduce((s, r) => s + (Number(r.vendas_recuperadas) || 0), 0);
    return { eventos, enviados, abertos, clicados, recuperados };
  },

  // Dashboard completo — KPIs + funil + eventos recentes + top campanhas, tudo REAL.
  async getDashboard(empresaId) {
    const db = await loadDB();
    const funnel = await this.getFunnel(empresaId);
    const camps = (db.campanhas || []).filter((c) => !empresaId || c.empresaId === empresaId);
    // Contagem de leads via COUNT no banco (o hydrate é cortado em 1000 pelo PostgREST).
    let lq = supabase.from('leads').select('id', { count: 'exact', head: true });
    if (empresaId) lq = lq.eq('organization_id', empresaId);
    const { count: leadsCount } = await lq;
    const enviados = funnel.enviados;
    const kpis = {
      leads: leadsCount || 0,
      enviados,
      abertura: enviados ? funnel.abertos / enviados : 0,
      ctr: enviados ? funnel.clicados / enviados : 0,
      recuperados: funnel.recuperados,
      ativas: camps.filter((c) => c.status === 'Ativa').length,
    };
    const recent = await this.getRecentEvents(8, empresaId);
    const topCampaigns = camps
      .map((c) => ({ id: c.id, nome: c.nome, status: c.status, recuperadas: c.stats.vendasRecuperadas, enviados: c.stats.emailsEnviados, taxaAbertura: c.stats.taxaAbertura }))
      .sort((a, b) => (b.recuperadas - a.recuperadas) || (b.enviados - a.enviados))
      .slice(0, 5);
    return { kpis, funnel, recent, topCampaigns };
  },

  // Jornada cronológica de UM lead: eventos de checkout + envios (e-mail/WhatsApp/SMS,
  // agendados/enviados/pulados/falhos) + tags aplicadas — mesclados e ordenados no tempo.
  // Fontes: webhook_events, scheduled_steps(→flow_steps→emails + campaigns), lead_tags(→tags).
  // Tudo escopado por RLS.
  async getLeadTimeline(leadId) {
    if (!leadId) return [];
    const items = [];

    // 1) Eventos de checkout recebidos (entrada e conversão)
    const { data: evs } = await supabase.from('webhook_events')
      .select('id, tipo_evento, produto, valor_produto, provider, created_at')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false });
    (evs || []).forEach((e) => items.push({
      id: 'ev_' + e.id, kind: 'evento', at: e.created_at,
      titulo: e.tipo_evento,
      sub: [e.produto, e.valor_produto != null ? money(e.valor_produto) : null].filter(Boolean).join(' · '),
      meta: e.provider || 'postback', tipoEvento: e.tipo_evento,
    }));

    // 2) Envios do fluxo (e-mail/WhatsApp/SMS) — resolve assunto via flow_steps→emails.
    // VERDADE do envio: o worker (process-steps) grava last_error=NULL quando o envio deu
    // certo e preenche last_error (inclusive p/ "pulado: ...") quando não envia — essa é a
    // única fonte confiável de estado por etapa. NÃO usar lead_metrics aqui: o worker nunca
    // preenche lead_metrics.etapa_email_origem_id, então indexar métricas por etapa sempre
    // resulta em "sem match" e classifica todo envio bem-sucedido como falha.
    // Atribuição de abertura/clique POR ETAPA não existe hoje (email_events não tem step_id
    // e lead_metrics não é gravado por etapa) — não é exibida aqui pra não inventar dado.
    const { data: steps } = await supabase.from('scheduled_steps')
      .select('id, status_agendamento, attempts, last_error, run_at, updated_at, created_at, step_id, flow_steps!step_id(nome, tipo_card, emails(assunto, titulo), campaign_flows!flow_id(campaigns(nome)))')
      .eq('lead_id', leadId)
      .order('run_at', { ascending: false });
    (steps || []).forEach((s) => {
      const fs = s.flow_steps || {};
      // Cards sem envio (Gatilho/Acionar Fluxo/Condição/Tags) não são itens de jornada.
      if (fs.tipo_card && fs.tipo_card !== 'Envio de e-mail' && fs.tipo_card !== 'Envio de WhatsApp' && fs.tipo_card !== 'Envio de SMS') return;
      const email = fs.emails || {};
      const camp = fs.campaign_flows && fs.campaign_flows.campaigns ? fs.campaign_flows.campaigns.nome : null;
      const canal = fs.tipo_card === 'Envio de WhatsApp' ? 'whatsapp' : fs.tipo_card === 'Envio de SMS' ? 'sms' : 'email';
      const finalizado = s.status_agendamento === 'Finalizado';
      const pulado = finalizado && typeof s.last_error === 'string' && s.last_error.startsWith('pulado');
      const enviado = finalizado && !pulado && !s.last_error;
      const falhou = finalizado && !pulado && !!s.last_error;
      // Motivo real do pulo (ex.: "condição '...' não atendida", "limite do plano atingido",
      // "destinatário descadastrado") — nunca hardcoded, senão um descadastro vira "condição
      // não atendida" na tela.
      const motivoPulado = pulado ? String(s.last_error).replace(/^pulado:\s*/, '') : null;
      // Motivo legível da falha (sem JSON bruto gigante) — ex.: domain not verified.
      let motivoFalha = null;
      if (falhou && s.last_error) {
        try {
          const j = JSON.parse(s.last_error);
          motivoFalha = j?.message || j?.detail || null;
        } catch {
          motivoFalha = String(s.last_error);
        }
        if (motivoFalha && motivoFalha.length > 80) motivoFalha = motivoFalha.slice(0, 77) + '…';
      }
      const estado = enviado ? 'Enviado'
        : pulado ? `Pulado (${motivoPulado})`
        : falhou ? [
            'Falha no envio',
            s.attempts ? `${s.attempts} tentativa${s.attempts === 1 ? '' : 's'}` : null,
            motivoFalha,
          ].filter(Boolean).join(' · ')
        : `Agendado (${s.status_agendamento})`;
      items.push({
        id: 'st_' + s.id, kind: 'email', canal,
        at: finalizado ? (s.updated_at || s.run_at) : s.run_at,
        titulo: email.assunto || fs.nome || (canal === 'whatsapp' ? 'WhatsApp' : canal === 'sms' ? 'SMS' : 'E-mail'),
        sub: [camp, estado].filter(Boolean).join(' · '),
        status: s.status_agendamento, enviado, falhou, pulado,
      });
    });

    // 3) Tags aplicadas (timestamp real)
    const { data: lts } = await supabase.from('lead_tags')
      .select('tag_id, created_at, tags(nome)')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false });
    (lts || []).forEach((t) => items.push({
      id: 'tg_' + t.tag_id, kind: 'tag', at: t.created_at,
      titulo: t.tags ? t.tags.nome : 'Tag', sub: 'Tag aplicada',
    }));

    // Ordena tudo por tempo (mais recente primeiro) e formata a data
    items.sort((a, b) => new Date(b.at) - new Date(a.at));
    return items.map((it) => ({ ...it, quando: it.at ? fmtDateTime(it.at) : '—' }));
  },

  // ---- Leads paginados no servidor (RPCs da 0029; RLS do usuário se aplica) ----
  // Reshape de uma linha do RPC leads_page pro shape que a UI (cards/drawer) consome.
  _leadRow(r) {
    return {
      id: r.id, empresaId: r.organization_id,
      nome: r.nome, sobrenome: r.sobrenome, email: r.email, telefone: r.telefone,
      produto: r.produto, valorCompra: Number(r.valor_compra) || 0, metodoPagamento: r.metodo_pagamento,
      ultimoEvento: r.ultimo_evento, criadoEm: fmtDate(r.created_at), createdAt: r.created_at,
      metricas: { enviados: Number(r.enviados) || 0, aberturas: Number(r.aberturas) || 0, cliques: Number(r.cliques) || 0 },
      tags: r.tag_ids || [], stage: r.stage,
    };
  },
  // Página de leads com filtros server-side. Retorna { rows, total }.
  // Filtros: stage (pipeline), search, evento (último), tagId, since (ISO/timestamptz).
  async getLeadsPage({
    empresaId = null, stage = null, search = null, evento = null,
    tagId = null, since = null, limit = 25, offset = 0,
  } = {}) {
    const { data, error } = await supabase.rpc('leads_page', {
      p_org: empresaId || null, p_stage: stage || null,
      p_search: (search || '').trim() || null, p_evento: evento || null,
      p_limit: limit, p_offset: offset,
      p_tag_id: tagId || null,
      p_since: since || null,
    });
    if (error) throw new Error(error.message);
    const rows = (data || []).map((r) => this._leadRow(r));
    const total = data && data.length ? Number(data[0].total_count) : 0;
    return { rows, total };
  },
  // Contagem + valor por estágio (headers do kanban). Mesmos filtros de getLeadsPage
  // (exceto stage/paginação) para o resumo refletir a busca/filtros ativos.
  // Aceita objeto de filtros OU string/null legado: getPipelineCounts(empresaId).
  async getPipelineCounts(opts = null) {
    const params = (opts && typeof opts === 'object' && !Array.isArray(opts))
      ? opts
      : { empresaId: opts };
    const { empresaId = null, search = null, evento = null, tagId = null, since = null } = params;
    const { data, error } = await supabase.rpc('pipeline_counts', {
      p_org: empresaId || null,
      p_search: (search || '').trim() || null,
      p_evento: evento || null,
      p_tag_id: tagId || null,
      p_since: since || null,
    });
    if (error) throw new Error(error.message);
    const out = {};
    (data || []).forEach((r) => { out[r.stage] = { total: Number(r.total) || 0, valor: Number(r.valor) || 0 }; });
    return out;
  },
  // Cards de status de e-mail da tela de Leads (contagens reais, sem carregar leads).
  async getLeadStatus() {
    const countOf = async (builder) => { const { count } = await builder; return count || 0; };
    // event='send' exclui os cliques em "Enviar teste" (event='send_test').
    const [enviados, rejeitados, fila] = await Promise.all([
      countOf(supabase.from('email_events').select('id', { count: 'exact', head: true }).eq('event', 'send').eq('status', 'enviado')),
      countOf(supabase.from('email_events').select('id', { count: 'exact', head: true }).eq('event', 'send').eq('status', 'falhou')),
      countOf(supabase.from('scheduled_steps').select('id', { count: 'exact', head: true }).in('status_agendamento', ['Iniciado', 'Em andamento'])),
    ]);
    return { processados: enviados + rejeitados, enviados, rejeitados, adiados: fila };
  },
  // Tags da org (nomes p/ o drawer) — lista pequena, via hydrate cacheado.
  async getTags() {
    const db = await loadDB();
    return clone(db.tags);
  },

  // Listas de apoio do construtor de fluxo (ids reais escopados por RLS).
  async getFlowOptions() {
    const db = await loadDB();
    return {
      webhooks: clone(db.webhooks),
      emails: clone(db.emails),
      whatsappMessages: clone(db.whatsappMessages || []),
      smsMessages: clone(db.smsMessages || []),
      tags: clone(db.tags),
      campaigns: db.campanhas.map((c) => ({ id: c.id, nome: c.nome })),
    };
  },

  // ---- Clientes (Gestor) --------------------------------------------------
  // MARCA-2: listClients agora também resolve o e-mail do CLIENTE (não do
  // fundador/gestor). O cliente é o profile com tipo='Cliente' vinculado à org
  // — criado automaticamente quando o gestor convida por e-mail.
  async listClients() {
    const db = await loadDB();
    return db.empresas.map((e) => {
      // Procura o cliente da org (pode não existir ainda se o convite está pendente).
      const cliente = db.users.find((u) => u.empresaId === e.id && u.tipo === 'Cliente');
      return {
        ...e, plano: planoById(db, e.planoId).nome,
        fundador: userById(db, e.fundadorId).nome,
        fundadorEmail: userById(db, e.fundadorId).email,
        clienteEmail: cliente ? cliente.email : null,
        clienteNome: cliente ? cliente.nome : null,
      };
    });
  },

  // ---- Integrações --------------------------------------------------------
  async getIntegrations() {
    const db = await loadDB();
    return {
      dominios: clone(db.dominios),
      webhooks: clone(db.webhooks),
      tags: clone(db.tags),
      emails: clone(db.emails),
    };
  },

  // ---- Marca / white-label ------------------------------------------------
  // MARCA-1: getBranding agora lê da tabela brands (1º brand da org).
  // Mantém a assinatura org_branding para retrocompatibilidade total.
  async getBranding(empresaId) {
    const me = await currentProfile();
    const orgId = empresaId || await firstOrgId(me);
    if (!orgId) return null;
    const { data } = await supabase.from('brands').select('*').eq('organization_id', orgId).order('ordem').limit(1).maybeSingle();
    if (data) return { organization_id: orgId, nome: data.nome, logo_url: data.logo_url, cor: data.cor, modo: data.modo, link_loja: data.link_loja, brand_id: data.id };
    return { organization_id: orgId, nome: '', logo_url: '', cor: '#ff6800', modo: 'dark', link_loja: '' };
  },
  // MARCA-1: CRUD de marcas (1:N). Substitui saveBranding para o caso multi-marca.
  async listBrands(empresaId) {
    const me = await currentProfile();
    const orgId = empresaId || await firstOrgId(me);
    if (!orgId) return [];
    const { data, error } = await supabase.from('brands').select('*').eq('organization_id', orgId).order('ordem');
    if (error) return [];
    return data || [];
  },
  async createBrand({ nome, cor, logoUrl, modo, linkLoja }, empresaId) {
    const me = await currentProfile();
    const orgId = empresaId || await firstOrgId(me);
    if (!orgId) return { error: 'no_org' };
    let link = (linkLoja || '').trim();
    if (link && !/^https?:\/\//i.test(link)) link = `https://${link}`;
    const { data, error } = await supabase.from('brands').insert({
      organization_id: orgId, nome: nome || null, cor: cor || '#ff6800', logo_url: logoUrl || null, modo: modo || 'dark', link_loja: link || null,
    }).select().single();
    resetDb();
    if (error) return { error: error.message };
    return { error: null, brand: data };
  },
  async updateBrand(brandId, patch) {
    let link = (patch.linkLoja || '').trim();
    if (link && !/^https?:\/\//i.test(link)) link = `https://${link}`;
    const { error } = await supabase.from('brands').update({
      nome: patch.nome, cor: patch.cor, logo_url: patch.logoUrl, modo: patch.modo, link_loja: link, updated_at: new Date().toISOString(),
    }).eq('id', brandId);
    resetDb();
    return { error: error ? error.message : null };
  },
  async deleteBrand(brandId) {
    const { error } = await supabase.from('brands').delete().eq('id', brandId);
    resetDb();
    return { error: error ? error.message : null };
  },
  // MARCA-1: vincula (ou desvincula) uma campanha a uma marca específica.
  async setCampaignBrand(campaignId, brandId) {
    const { error } = await supabase.from('campaigns')
      .update({ brand_id: brandId || null, updated_at: new Date().toISOString() })
      .eq('id', campaignId);
    resetDb();
    return !error;
  },
  async saveBranding(empresaId, { nome, cor, logoUrl, modo, linkLoja }) {
    const me = await currentProfile();
    const orgId = empresaId || await firstOrgId(me);
    if (!orgId) return { error: 'no_org' };
    let link = (linkLoja || '').trim();
    if (link && !/^https?:\/\//i.test(link)) link = `https://${link}`;
    // MARCA-1: salva no 1º brand da org (retrocompatível com a UI antiga).
    const { data: first } = await supabase.from('brands').select('id').eq('organization_id', orgId).order('ordem').limit(1).maybeSingle();
    if (first) {
      const { error } = await supabase.from('brands').update({
        nome: nome || null, cor: cor || '#ff6800', logo_url: logoUrl || null, modo: modo === 'light' ? 'light' : 'dark', link_loja: link || null, updated_at: new Date().toISOString(),
      }).eq('id', first.id);
      resetDb();
      return { error };
    }
    // Sem brand ainda → cria o primeiro.
    const { error } = await supabase.from('brands').insert({
      organization_id: orgId, nome: nome || null, cor: cor || '#ff6800', logo_url: logoUrl || null, modo: modo || 'dark', link_loja: link || null,
    });
    resetDb();
    return { error };
  },
  async uploadLogo(file, empresaId) {
    const me = await currentProfile();
    const orgId = empresaId || await firstOrgId(me);
    if (!orgId || !file) return { error: 'missing' };
    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const path = `${orgId}/logo-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('branding').upload(path, file, { upsert: true, contentType: file.type || 'image/png' });
    if (error) return { error };
    const { data } = supabase.storage.from('branding').getPublicUrl(path);
    return { url: data.publicUrl };
  },

  // ---- Postback Tokens ----------------------------------------------------
  async getPostbackTokens() {
    const me = await currentProfile();
    const orgId = await firstOrgId(me);
    if (!orgId) return [];
    const { data, error } = await supabase.from('postback_tokens')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false });
    if (error) return [];
    return data || [];
  },
  async getOrCreatePostbackToken(empresaId) {
    const me = await currentProfile();
    const orgId = empresaId || await firstOrgId(me);
    if (!orgId) return null;
    // Busca token existente
    const { data: existing } = await supabase.from('postback_tokens')
      .select('*')
      .eq('organization_id', orgId)
      .eq('ativo', true)
      .limit(1)
      .maybeSingle();
    if (existing) return existing;
    // Cria novo via RPC
    const { data, error } = await supabase.rpc('create_postback_token', {
      p_org_id: orgId,
      p_nome: 'Token principal',
    });
    if (error) return null;
    return data;
  },
  async createPostbackToken(nome, empresaId) {
    const me = await currentProfile();
    const orgId = empresaId || await firstOrgId(me);
    if (!orgId) return { ok: false, error: 'Conta não encontrada.' };
    const { data, error } = await supabase.rpc('create_postback_token', {
      p_org_id: orgId,
      p_nome: nome || 'Novo token',
    });
    if (error) {
      // O trigger enforce_limite_integracoes levanta check_violation com a
      // mensagem 'limite_integracoes_atingido: o plano permite N integracao(oes)
      // de checkout. Exclua uma (revogar não libera a vaga) ou faça upgrade.' —
      // mostrar isso, não um genérico.
      const msg = String(error.message || '');
      if (msg.includes('limite_integracoes_atingido')) {
        return { ok: false, error: msg.replace(/^.*?limite_integracoes_atingido:\s*/, '') };
      }
      return { ok: false, error: 'Não foi possível criar o webhook' };
    }
    resetDb();
    return { ok: true, token: data };
  },
  async revokePostbackToken(tokenId) {
    const { error } = await supabase.from('postback_tokens')
      .update({ ativo: false })
      .eq('id', tokenId);
    resetDb();
    return !error;
  },
  // WEB-1: renomeia um webhook nomeado (mantém o token, só muda o rótulo).
  async renamePostbackToken(tokenId, nome) {
    const clean = (nome || '').trim();
    if (!clean) return false;
    const { error } = await supabase.from('postback_tokens')
      .update({ nome: clean, updated_at: new Date().toISOString() })
      .eq('id', tokenId);
    resetDb();
    return !error;
  },
  // WEB-1: reativa um webhook que estava desativado.
  async activatePostbackToken(tokenId) {
    const { error } = await supabase.from('postback_tokens')
      .update({ ativo: true, updated_at: new Date().toISOString() })
      .eq('id', tokenId);
    resetDb();
    return !error;
  },
  // WEB-1: exclui um webhook nomeado (hard delete). Campanhas vinculadas
  // ficam com postback_token_id = NULL (ON DELETE SET NULL) → voltam ao
  // comportamento padrão (qualquer token da org).
  async deletePostbackToken(tokenId) {
    const { error } = await supabase.from('postback_tokens').delete().eq('id', tokenId);
    resetDb();
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  },
  // WEB-1: vincula (ou desvincula) uma campanha a um webhook nomeado.
  // tokenId=null → "qualquer webhook" (padrão retrocompatível).
  async setCampaignWebhook(campaignId, tokenId) {
    const { error } = await supabase.from('campaigns')
      .update({ postback_token_id: tokenId || null, updated_at: new Date().toISOString() })
      .eq('id', campaignId);
    resetDb();
    return !error;
  },

  // ---- Últimos eventos recebidos ------------------------------------------
  async getRecentEvents(limit = 20, empresaId) {
    const me = await currentProfile();
    const orgId = empresaId || await firstOrgId(me);
    if (!orgId) return [];
    const { data, error } = await supabase.from('webhook_events')
      .select('id, tipo_evento, email, produto, valor_produto, provider, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return data || [];
  },
  async createTag(tag) {
    const me = await currentProfile();
    const orgId = await firstOrgId(me);
    if (!orgId) throw new Error('Sua conta ainda não tem organização configurada.');
    const { data, error } = await supabase.from('tags').insert({
      organization_id: orgId, nome: tag.nome, descricao: tag.descricao, tipo_evento: tag.tipoEvento || null,
    }).select().single();
    if (error) throw error;
    resetDb();
    return { id: data.id, nome: data.nome, descricao: data.descricao, tipoEvento: data.tipo_evento, empresaId: data.organization_id };
  },

  // ---- Perfil (update) ----------------------------------------------------
  async updateProfile(patch) {
    const me = await currentProfile();
    if (!me) return { error: 'Sem sessão' };
    const { error } = await supabase.from('profiles').update({
      nome: patch.nome, celular: patch.celular, local: patch.local,
    }).eq('id', me.id);
    resetDb();
    return { error: error ? error.message : null };
  },

  // ---- Webhooks (create + provider + secret + signing_secret + eventos) ----
  async createWebhook({ nome, descricao, eventos, provider, signingSecret }) {
    const me = await currentProfile();
    const orgId = await firstOrgId(me);
    // Auditoria E2E (Canais A2): o secret do webhook é a ÚNICA auth do caminho
    // generic — Math.random() (~48 bits, previsível) era forjável. Agora CSPRNG,
    // 192 bits em hex, via Web Crypto.
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const prov = provider || 'generic';
    const base = SUPABASE_URL;
    const secret = 'whsec_' + rand;
    // generic = legado (secret no corpo). Demais plataformas = postback identificado por token na URL.
    const url = prov === 'generic'
      ? `${base}/functions/v1/webhook-receiver`
      : `${base}/functions/v1/webhook-receiver?provider=${prov}&token=${secret}`;
    const { data: wh, error } = await supabase.from('webhooks').insert({
      organization_id: orgId, nome, descricao: descricao || '', url, secret,
      provider: prov, signing_secret: signingSecret || null, testado: false, desabilitado: false,
    }).select().single();
    if (error) throw error;
    if ((eventos || []).length) {
      await supabase.from('webhook_event_types').insert(eventos.map((e) => ({ webhook_id: wh.id, tipo_evento: e })));
    }
    resetDb();
    return { id: wh.id, nome, descricao: descricao || '', url, secret, provider: prov, testado: false, desabilitado: false, eventos: eventos || [] };
  },

  // ---- E-mail (create de template) -----------------------------------------
  // Cria um template novo com corpo base renderizado na marca da org — antes o
  // "Novo template" da UI só chamava updateEmail e não criava nada.
  async createEmail({ titulo, assunto, remetente, corpoHtml }, empresaId) {
    const me = await currentProfile();
    const orgId = empresaId || await firstOrgId(me);
    if (!orgId) return { error: 'Sua conta ainda não tem organização configurada.', id: null };
    let html = (corpoHtml || '').trim();
    if (!html) {
      let brand = { name: remetente || 'Sua loja' };
      try {
        const b = await this.getBranding(orgId);
        if (b) brand = { name: b.nome || brand.name, logoUrl: b.logo_url || undefined, color: b.cor || undefined, mode: b.modo || 'dark' };
      } catch (e) { /* usa default */ }
      html = renderEmail({
        brand, preheader: assunto || '',
        blocks: [
          { type: 'hero', title: titulo || 'Você esqueceu algo', text: '' },
          { type: 'button', label: 'Concluir compra', href: '{{cta_link}}' },
        ],
      });
    }
    const { data, error } = await supabase.from('emails').insert({
      organization_id: orgId, titulo: titulo || 'Novo template', assunto: assunto || '',
      remetente: remetente || null, corpo_html: html, created_by: me ? me.id : null,
    }).select().single();
    resetDb();
    return { error: error ? error.message : null, id: data ? data.id : null };
  },

  // ---- E-mail (update do template) ----------------------------------------
  async updateEmail(id, patch) {
    if (!id) return { error: 'ID do e-mail ausente' };
    // Só envia campos presentes no patch (evita apagar corpo_html quando a UI
    // simples de Integrações manda só título/assunto/remetente).
    const row = {};
    if (patch.titulo !== undefined) row.titulo = patch.titulo;
    if (patch.assunto !== undefined) row.assunto = patch.assunto;
    if (patch.remetente !== undefined) row.remetente = patch.remetente;
    if (patch.corpoHtml !== undefined) row.corpo_html = patch.corpoHtml;
    if (Object.keys(row).length === 0) return { error: null };
    const { error } = await supabase.from('emails').update(row).eq('id', id);
    resetDb();
    return { error: error ? error.message : null };
  },

  // ---- E-mail (envio via Resend, Edge Function send-email) ----------------
  // fromName: nome de exibição do remetente (campo "Remetente" do editor).
  // A edge function monta "Nome <email_verificado>" com o domínio do Vault.
  async sendTestEmail({ to, subject, html, text, from, fromName }) {
    // No teste não há lead, então resolve o {{cta_link}} pela URL da loja (ou '#').
    let testHtml = html || '';
    if (testHtml.includes('{{cta_link}}')) {
      let fallback = '#';
      try { const b = await this.getBranding(); if (b && b.link_loja) fallback = b.link_loja; } catch (e) { /* usa '#' */ }
      testHtml = testHtml.split('{{cta_link}}').join(fallback);
    }
    const { data, error } = await supabase.functions.invoke('send-email', {
      body: { to, subject, html: testHtml, text, from, fromName: fromName || undefined },
    });
    if (error) {
      // Em não-2xx (FunctionsHttpError) o corpo vem em error.context — tenta ler
      // para transformar erros conhecidos em mensagem amigável.
      const body = await error.context?.json?.().catch(() => null);
      if (body && body.error === 'secret_unavailable') return { error: 'Resend não configurado — a API key é definida pelo suporte.' };
      if (body && (body.detail || body.error)) {
        const msg = (body.detail && typeof body.detail === 'object') ? body.detail.message : body.detail;
        return { error: msg || body.error };
      }
      return { error: error.message };
    }
    // A function responde 200 {"ok":false,"skipped":"suppressed"} (sem campo 'error')
    // quando o destinatário está na lista de supressão — sem este ramo o código caía
    // direto no "sucesso" abaixo e a tela mostrava "e-mail de teste enviado" quando,
    // na verdade, nada foi enviado.
    if (data && data.skipped === 'suppressed') {
      return { error: 'Destinatário está na lista de supressão (descadastrado ou bounce permanente).' };
    }
    if (data && data.error) {
      if (data.error === 'secret_unavailable') return { error: 'Resend não configurado (falta a API key).' };
      const msg = (data.detail && typeof data.detail === 'object') ? data.detail.message : data.detail;
      return { error: msg || data.error || 'Falha no envio' };
    }
    return { error: null, id: data && data.id };
  },

  // ---- WhatsApp (mensagens + envio de teste via Edge Function send-whatsapp)
  // Mesma modelagem dos templates de e-mail: lista escopada por RLS, título +
  // corpo em texto puro com suporte ao placeholder {{cta_link}}.
  async listWhatsappMessages() {
    const db = await loadDB();
    return clone(db.whatsappMessages || []);
  },
  // Cria (sem id) ou atualiza (com id) uma mensagem de WhatsApp da org.
  // botoes: array [{id,type,label,url?,phone?}] — botões interativos Z-API.
  async saveWhatsappMessage({ id, titulo, corpoTexto, mediaUrl, botoes }, empresaId) {
    const buttons = Array.isArray(botoes) ? botoes : [];
    if (id) {
      const { error } = await supabase.from('whatsapp_messages').update({
        titulo, corpo_texto: corpoTexto, media_url: mediaUrl || null, botoes: buttons,
        updated_at: new Date().toISOString(),
      }).eq('id', id);
      resetDb();
      return { error: error ? error.message : null, id };
    }
    const me = await currentProfile();
    const orgId = empresaId || await firstOrgId(me);
    if (!orgId) return { error: 'Sua conta ainda não tem organização configurada.', id: null };
    const { data, error } = await supabase.from('whatsapp_messages').insert({
      organization_id: orgId, titulo, corpo_texto: corpoTexto, media_url: mediaUrl || null,
      botoes: buttons, created_by: me ? me.id : null,
    }).select().single();
    resetDb();
    return { error: error ? error.message : null, id: data ? data.id : null };
  },
  // Envio de teste — espelha o sendTestEmail: no teste não há lead, então o
  // {{cta_link}} é resolvido pela URL da loja (ou '#'). Credenciais Z-API ficam
  // no Vault e são resolvidas pela própria edge function.
  // buttonActions: botões interativos (opcional).
  async sendTestWhatsapp({ phone, message, buttonActions }) {
    let testMsg = message || '';
    let ctaFallback = '#';
    try { const b = await this.getBranding(); if (b && b.link_loja) ctaFallback = b.link_loja; } catch (e) { /* usa '#' */ }
    if (testMsg.includes('{{cta_link}}')) {
      testMsg = testMsg.split('{{cta_link}}').join(ctaFallback);
    }
    const { data, error } = await supabase.functions.invoke('send-whatsapp', {
      body: {
        phone,
        message: testMsg,
        buttonActions: Array.isArray(buttonActions) && buttonActions.length ? buttonActions : undefined,
        ctaLink: ctaFallback !== '#' ? ctaFallback : undefined,
      },
    });
    if (error) {
      // Em não-2xx (FunctionsHttpError) o corpo vem em error.context — tenta ler
      // para transformar erros conhecidos em mensagem amigável.
      const body = await error.context?.json?.().catch(() => null);
      if (body && body.error === 'secret_unavailable') return { error: 'Z-API não configurada — as credenciais são definidas pelo suporte.' };
      if (body && (body.detail || body.error)) {
        const msg = (body.detail && typeof body.detail === 'object') ? body.detail.message : body.detail;
        return { error: msg || body.error };
      }
      return { error: error.message };
    }
    if (data && data.error) {
      if (data.error === 'secret_unavailable') return { error: 'Z-API não configurada (faltam as credenciais no Vault).' };
      const msg = (data.detail && typeof data.detail === 'object') ? data.detail.message : data.detail;
      return { error: msg || data.error || 'Falha no envio' };
    }
    return { error: null, id: data && data.id };
  },

  // ---- SMS (GTI SMS) — espelha WhatsApp (texto puro + {{cta_link}}/{{nome}}) -----
  async listSmsMessages() {
    const db = await loadDB();
    return clone(db.smsMessages || []);
  },
  // Cria (sem id) ou atualiza (com id) uma mensagem de SMS da org.
  async saveSmsMessage({ id, titulo, corpoTexto }, empresaId) {
    if (id) {
      const { error } = await supabase.from('sms_messages').update({
        titulo, corpo_texto: corpoTexto, updated_at: new Date().toISOString(),
      }).eq('id', id);
      resetDb();
      return { error: error ? error.message : null, id };
    }
    const me = await currentProfile();
    const orgId = empresaId || await firstOrgId(me);
    if (!orgId) return { error: 'Sua conta ainda não tem organização configurada.', id: null };
    const { data, error } = await supabase.from('sms_messages').insert({
      organization_id: orgId, titulo, corpo_texto: corpoTexto, created_by: me ? me.id : null,
    }).select().single();
    resetDb();
    return { error: error ? error.message : null, id: data ? data.id : null };
  },
  // Envio de teste de SMS — espelha sendTestWhatsapp. {{cta_link}} resolvido pela
  // URL da loja (ou vazio). Token da GTI fica no Vault (edge function).
  async sendTestSms({ to, message }) {
    let testMsg = message || '';
    let ctaFallback = '';
    try { const b = await this.getBranding(); if (b && b.link_loja) ctaFallback = b.link_loja; } catch (e) { /* vazio */ }
    testMsg = testMsg.split('{{cta_link}}').join(ctaFallback);
    const { data, error } = await supabase.functions.invoke('send-sms', {
      body: { to, message: testMsg },
    });
    if (error) {
      const body = await error.context?.json?.().catch(() => null);
      if (body && body.error === 'secret_unavailable') return { error: 'SMS não configurado — as credenciais são definidas pelo suporte.' };
      if (body && (body.detail || body.error)) {
        const msg = (body.detail && typeof body.detail === 'object') ? body.detail.message : body.detail;
        return { error: msg || body.error };
      }
      return { error: error.message };
    }
    if (data && data.error) {
      if (data.error === 'secret_unavailable') return { error: 'SMS não configurado (falta o token da GTI no Vault).' };
      const msg = (data.detail && typeof data.detail === 'object') ? data.detail.message : data.detail;
      return { error: msg || data.error || 'Falha no envio' };
    }
    return { error: null, sid: data && data.sid, segments: data && data.segments };
  },

  // ---- Disparo em massa (bulk send) — email / WhatsApp / SMS -----------------
  // filter: { tag_ids?: uuid[], evento?: string }. canal: 'email' | 'whatsapp' | 'sms'.
  async estimateBulkAudience({ canal, filter, organizationId }) {
    const { data, error } = await supabase.functions.invoke('bulk-send', {
      body: { action: 'estimate', canal, filter: filter || {}, organization_id: organizationId },
    });
    if (error) { const body = await error.context?.json?.().catch(() => null); return { error: (body && (body.detail || body.error)) || error.message }; }
    if (data && data.error) return { error: data.detail || data.error };
    return { error: null, total: data.total || 0 };
  },
  async createBulkSend({ canal, templateId, filter, ratePorMin, organizationId }) {
    const { data, error } = await supabase.functions.invoke('bulk-send', {
      body: { action: 'create', canal, template_id: templateId, filter: filter || {}, rate_por_min: ratePorMin, organization_id: organizationId },
    });
    if (error) { const body = await error.context?.json?.().catch(() => null); return { error: (body && (body.detail || body.error)) || error.message }; }
    if (data && data.error) return { error: data.detail || data.error };
    return { error: null, bulkSendId: data.bulk_send_id, total: data.total };
  },
  async bulkSendStatus(id) {
    const { data, error } = await supabase.functions.invoke('bulk-send', { body: { action: 'status', id } });
    if (error) { const body = await error.context?.json?.().catch(() => null); return { error: (body && (body.detail || body.error)) || error.message }; }
    return data || {};
  },
  async listBulkSends(empresaId) {
    let q = supabase.from('bulk_sends').select('*').order('created_at', { ascending: false }).limit(20);
    if (empresaId) q = q.eq('organization_id', empresaId);
    const { data, error } = await q;
    if (error) { console.error('[mockApi] listBulkSends:', error.message); return []; }
    return data || [];
  },

  // Estado da conexão WhatsApp (Z-API): conectado? qual número/nome está plugado?
  // Mostrado na aba WhatsApp pra ninguém precisar abrir o painel da Z-API.
  async getWhatsappStatus() {
    const { data, error } = await supabase.functions.invoke('send-whatsapp', { body: { action: 'status' } });
    if (error) {
      const body = await error.context?.json?.().catch(() => null);
      if (body && body.error === 'secret_unavailable') return { error: 'Z-API não configurada — as credenciais são definidas pelo suporte.' };
      return { error: (body && (body.detail || body.error)) || error.message };
    }
    if (data && data.error) return { error: data.detail || data.error };
    return { error: null, connected: !!(data && data.connected), smartphoneConnected: !!(data && data.smartphoneConnected), phone: (data && data.phone) || null, name: (data && data.name) || null };
  },

  // Telefone de teste WhatsApp persistido no profile (whatsapp_teste).
  async getWhatsappTestPhone() {
    const me = await currentProfile();
    return { phone: (me && me.whatsapp_teste) || '' };
  },
  async saveWhatsappTestPhone(phone) {
    const me = await currentProfile();
    if (!me) return { error: 'Sem sessão' };
    const digits = String(phone || '').replace(/\D/g, '');
    const { error } = await supabase.from('profiles').update({ whatsapp_teste: digits || null }).eq('id', me.id);
    resetDb();
    return { error: error ? error.message : null };
  },

  // ---- Domínio de envio (Resend) ----------------------------------------
  async listSendingDomains(empresaId) {
    const me = await currentProfile();
    const orgId = empresaId || await firstOrgId(me);
    const { data, error } = await supabase.functions.invoke('resend-admin', {
      body: { action: 'list', organization_id: orgId },
    });
    if (error) {
      const body = await error.context?.json?.().catch(() => null);
      return { error: (body && (body.detail || body.error)) || error.message, domains: [] };
    }
    if (data && data.error) return { error: data.detail || data.error, domains: [] };
    return {
      error: null, domains: data.domains || [],
      // Remetente automático da org (subdomínio da plataforma) + domínio de envio ativo.
      senderLocal: data.sender_local || null, sendingDomain: data.sending_domain || null,
    };
  },
  async createSendingDomain({ name, fromEmail }, empresaId) {
    const me = await currentProfile();
    const orgId = empresaId || await firstOrgId(me);
    const { data, error } = await supabase.functions.invoke('resend-admin', {
      body: { action: 'create', name, from_email: fromEmail, organization_id: orgId },
    });
    if (error) {
      const body = await error.context?.json?.().catch(() => null);
      return { error: (body && (body.detail || body.error)) || error.message };
    }
    if (data && data.error) return { error: typeof data.detail === 'object' ? (data.detail.message || JSON.stringify(data.detail)) : (data.detail || data.error) };
    resetDb();
    return { error: null, domain: data.domain };
  },
  async verifySendingDomain(domainId) {
    const { data, error } = await supabase.functions.invoke('resend-admin', {
      body: { action: 'verify', id: domainId },
    });
    if (error) {
      const body = await error.context?.json?.().catch(() => null);
      return { error: (body && (body.detail || body.error)) || error.message };
    }
    if (data && data.error) return { error: data.detail || data.error };
    resetDb();
    return { error: null, domain: data.domain, verified: data.domain && (data.domain.validado || data.domain.status === 'verified') };
  },
  async deleteSendingDomain(domainId) {
    const { data, error } = await supabase.functions.invoke('resend-admin', {
      body: { action: 'delete', id: domainId },
    });
    if (error) {
      const body = await error.context?.json?.().catch(() => null);
      return { error: (body && (body.detail || body.error)) || error.message };
    }
    if (data && data.error) return { error: data.detail || data.error };
    resetDb();
    return { error: null };
  },

  // ---- Asaas (gateway) --------------------------------------------------
  async getAsaasStatus() {
    const { data, error } = await supabase.functions.invoke('asaas', { body: { action: 'status' } });
    if (error) {
      const body = await error.context?.json?.().catch(() => null);
      return { configured: false, error: (body && (body.detail || body.error)) || error.message };
    }
    return { configured: !!(data && data.configured), env: data && data.env, error: null };
  },
  async createAsaasCheckout({ planId, billingType, cycle, organizationId }) {
    const { data, error } = await supabase.functions.invoke('asaas', {
      body: {
        action: 'create_payment',
        plan_id: planId,
        billingType: billingType || 'PIX',
        cycle: cycle || 'MONTHLY',
        organization_id: organizationId,
      },
    });
    if (error) {
      // Erro HTTP não-2xx: o corpo traz o código (ex.: documento_ausente, que a
      // edge function devolve com 400 quando a org não tem CPF/CNPJ).
      const body = await error.context?.json?.().catch(() => null);
      return { error: asaasErrorMessage(body?.detail || body?.error || error.message), code: body && body.error };
    }
    if (data && data.error) {
      const d = data.detail;
      return { error: asaasErrorMessage(d || data.error), code: data.error };
    }
    return {
      error: null, invoiceUrl: data.invoiceUrl, paymentId: data.paymentId,
      // PIX: QR (imagem base64) + copia-e-cola (payload EMV) vindos do follow-up
      // GET /payments/{id}/pixQrCode na edge function.
      pixQrCode: data.pixQrCode || null, pixCopyPaste: data.pixCopyPaste || null, pixExpiration: data.pixExpiration || null,
      env: data.env, value: data.value, plan: data.plan,
    };
  },

  // ---- Onboarding self-service (Cliente sem org cria a própria) -----------
  async createOwnOrg({ nome, segmento }) {
    const { data, error } = await supabase.rpc('create_own_org', { p_nome: nome, p_segmento: segmento || null });
    resetDb();
    if (error) return { error: error.message, org: null };
    return { error: null, org: data };
  },
  // Nichos de interesse escolhidos no onboarding (profiles.curadoria text[]).
  async saveCuradoria(nichos) {
    const me = await currentProfile();
    if (!me) return { error: 'Sem sessão' };
    const { error } = await supabase.from('profiles').update({ curadoria: nichos || [] }).eq('id', me.id);
    resetDb();
    return { error: error ? error.message : null };
  },

  // ---- Organizações / contas (Gestor cria; membro edita básico) -----------
  // MARCA-2: createOrganization cria a org (com plano opcional) E convida o
  // cliente por e-mail via Edge Function invite-client. O cliente recebe um
  // convite do Supabase Auth e, ao definir a senha, seu profile já nasce
  // vinculado à org (handle_new_user lê organization_id do metadata).
  async createOrganization({ nome, segmento, email, planoId, documento }) {
    // 1) Cria a org gerida (gestor vira membro Gestor da conta)
    const rpcParams = { p_nome: nome, p_segmento: segmento || null };
    if (planoId) rpcParams.p_plano_id = planoId;
    const { data: org, error } = await supabase.rpc('create_managed_org', rpcParams);
    resetDb();
    if (error) return { error: error.message };

    // 1b) Documento fiscal: a RPC não recebe (assinatura fixa), então grava em
    // seguida — o gestor já é membro da org, o RLS de update permite. Falha aqui
    // não bloqueia o convite: a org já existe e o documento é editável depois.
    let documentoError = null;
    if (documento && org && org.id) {
      const { error: docErr } = await supabase.from('organizations').update({ documento }).eq('id', org.id);
      resetDb();
      if (docErr) documentoError = docErr.message;
    }
    const done = (extra) => ({ error: null, org, documentoError, ...extra });

    // 2) Convida o cliente por e-mail (se informado)
    if (email && org && org.id) {
      const { data: { session } } = await supabase.auth.getSession();
      const base = SUPABASE_URL;
      try {
        const res = await fetch(`${base}/functions/v1/invite-client`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.access_token || ''}`,
          },
          body: JSON.stringify({ org_id: org.id, email: email.trim(), nome: nome.trim() }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok && !json.already_exists) {
          // Org criada mas convite falhou — informa mas não bloqueia.
          return done({ inviteError: json.detail || json.error || 'Falha no convite' });
        }
        return done({ invited: !json.already_exists, alreadyExists: !!json.already_exists });
      } catch (e) {
        return done({ inviteError: 'Falha ao conectar no convite' });
      }
    }
    return done();
  },
  // `documento` (CPF/CNPJ) precisa chegar NORMALIZADO — o CHECK
  // organizations_documento_valido rejeita valor mascarado ou com DV errado,
  // inclusive no formato alfanumérico (IN RFB 2.229). Use normalizeDoc().
  async updateOrganization(id, patch) {
    const upd = {};
    if (patch.nome !== undefined) upd.nome = patch.nome;
    if (patch.segmento !== undefined) upd.segmento = patch.segmento;
    if (patch.documento !== undefined) upd.documento = patch.documento || null;
    if (!Object.keys(upd).length) return { error: null };
    const { error } = await supabase.from('organizations').update(upd).eq('id', id);
    resetDb();
    return { error: error ? error.message : null };
  },
  // Documento da org logada — o checkout Asaas exige (POST /customers pede cpfCnpj).
  async getOrgDocumento(orgId) {
    if (!orgId) return '';
    const db = await loadDB();
    const org = db.empresas.find((e) => e.id === orgId);
    return (org && org.documento) || '';
  },

  // ---- Planos -------------------------------------------------------------
  async getPlans() {
    const db = await loadDB();
    const me = await currentProfile();
    // Staff (Suporte/Admin) não tem org: visão plataforma (todos os planos + transações),
    // sem card de uso — nada de escolher uma org arbitrária.
    const org = db.empresas.find((e) => e.id === (me && me.organization_id)) || null;
    const plano = (org && db.planos.find((p) => p.id === org.planoId)) || null;
    const usoCamp = org ? db.campanhas.filter((c) => c.empresaId === org.id).length : 0;
    let usage = null;
    if (org) {
      const { data: uc } = await supabase.from('usage_counters').select('*').eq('organization_id', org.id).maybeSingle();
      usage = uc || null;
    }
    return {
      planos: clone(db.planos),
      atual: plano ? clone(plano) : null,
      uso: plano ? { campanhas: usoCamp, limiteCampanhas: plano.limiteCampanhas, execucoes: usage ? Number(usage.numero_execucoes) : 0, limiteExecucoes: plano.limiteExecucoes } : null,
      transacoes: db.transacoes.map((t) => ({ ...t, usuario: userById(db, t.userId).nome, plano: planoById(db, t.planoId).nome })),
    };
  },
  async createPlan(p) {
    const { data, error } = await supabase.from('plans').insert({
      nome: p.nome, descricao: p.descricao, valor_mensal: p.valorMensal, valor_anual: p.valorAnual,
      valor_semestral: p.valorSemestral ?? null,
      limite_campanhas: p.limiteCampanhas, limite_execucoes: p.limiteExecucoes,
      // Campo agora exposto no formulário (Peça 5), então a escolha é deliberada
      // em vez de herdada do default da coluna. Contrato de enforce_limite_integracoes
      // não muda: vazio/0 continua significando ILIMITADO (v_limite is null or <= 0).
      limite_integracoes: p.limiteIntegracoes ?? 0,
      preco_excedente: p.precoExcedente ?? null,
      sms_habilitado: !!p.smsHabilitado,
      disparo_massa_habilitado: !!p.disparoMassaHabilitado,
      dominio_proprio_habilitado: !!p.dominioProprioHabilitado,
      status: 'Ativo', deleted: false,
    }).select().single();
    if (error) throw error;
    resetDb();
    return { id: data.id, status: data.status, deleted: false, ...p };
  },

  // ---- Chamados (chat) ----------------------------------------------------
  async listConversations() {
    const db = await loadDB();
    return clone(db.conversas);
  },
  // Cria chamado (manual ou escalado do chat IA). `transcript` = mensagens do widget
  // ({from:'user'|'ai', text}) que entram como autor='sistema' via RPC SECURITY DEFINER
  // (a RLS proíbe o Cliente de postar autor≠'cliente' direto).
  async createConversation({ assunto, tipo = 'Dúvidas', prioridade = 'Média', origem = 'manual', mensagem = null, transcript = [] }) {
    const { data: convId, error } = await supabase.rpc('create_support_conversation', {
      p_assunto: assunto || '',
      p_tipo: tipo,
      p_prioridade: prioridade,
      p_origem: origem,
      p_mensagem: mensagem,
      p_transcript: (transcript || []).map((m) => ({ from: m.from, text: String(m.text || '').slice(0, 4000) })),
    });
    resetDb();
    if (error) return { error: error.message, id: null };
    return { error: null, id: convId };
  },
  // Atribui a conversa a um atendente (null = desatribuir).
  async assignConversation(convId, profileId) {
    const { error } = await supabase.from('support_conversations').update({ assigned_to: profileId || null }).eq('id', convId);
    resetDb();
    return !error;
  },
  // Marca como lida do lado do chamador (a coluna depende do papel).
  async markConversationRead(convId) {
    const me = await currentProfile();
    if (!me) return false;
    const isStaff = me.tipo_user_geral === 'Suporte' || me.tipo_user_geral === 'Administrador';
    const col = isStaff ? 'support_last_read_at' : 'cliente_last_read_at';
    const { error } = await supabase.from('support_conversations').update({ [col]: new Date().toISOString() }).eq('id', convId);
    return !error;
  },
  // Envia mensagem e retorna a row inserida (append otimista no client; o Realtime
  // cuida do outro lado). Autor/nome resolvidos pelo perfil — nada hardcoded.
  async sendMessage(convId, texto) {
    const me = await currentProfile();
    const isStaff = me && (me.tipo_user_geral === 'Suporte' || me.tipo_user_geral === 'Administrador');
    const { data: msg, error } = await supabase.from('support_messages').insert({
      conversation_id: convId, autor: isStaff ? 'suporte' : 'cliente',
      profile_id: me ? me.id : null, nome: me ? me.nome : null,
      mensagem: String(texto || '').slice(0, 8000),
    }).select().single();
    // Toca o updated_at p/ reordenar a fila e emitir o UPDATE no Realtime.
    await supabase.from('support_conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId);
    resetDb();
    return error ? null : msg; // row snake_case; reshape no consumidor
  },
  async resolveConversation(convId) {
    const { error } = await supabase.from('support_conversations').update({ status_chamado: 'Resolvida' }).eq('id', convId);
    resetDb();
    return !error;
  },

  // ---- Suporte / FAQ ------------------------------------------------------
  async getHelp() { const db = await loadDB(); return { faq: clone(db.faq) }; },

  // ---- Segurança (Admin) --------------------------------------------------
  async getSecurity() {
    const db = await loadDB();
    return {
      users: db.users.map((u) => ({ ...u, empresa: u.empresaId ? empresaNome(db, u.empresaId) : '—' })),
      historico: clone(db.historicoAcesso),
      sessoes: clone(db.sessoesAtivas),
      webhooks: clone(db.webhooks),
    };
  },
  async setUserStatus(id, status) {
    const { error } = await supabase.from('profiles').update({ status_user: status }).eq('id', id);
    resetDb();
    return !error;
  },
  async endSession(id) {
    const { error } = await supabase.from('active_sessions').delete().eq('id', id);
    resetDb();
    return !error;
  },

  // ---- Relatórios globais — 100% dados reais (email_events / campaigns / stats)
  async getReports(range = '90d') {
    const db = await loadDB();
    const days = range === '30d' ? 30 : 90;
    const { keys, labels } = dayAxis(days);
    const sinceIso = new Date(Date.now() - days * 864e5).toISOString();

    // Desempenho por conta (campaign_stats já hidratado e escopado por RLS)
    const porConta = db.empresas.map((e) => {
      const camps = db.campanhas.filter((c) => c.empresaId === e.id);
      const enviados = camps.reduce((s, c) => s + c.stats.emailsEnviados, 0);
      const vendas = camps.reduce((s, c) => s + c.stats.vendasRecuperadas, 0);
      const ab = camps.length ? camps.reduce((s, c) => s + c.stats.taxaAbertura, 0) / camps.length : 0;
      return { id: e.id, conta: e.nome, segmento: e.segmento, plano: planoById(db, e.planoId).nome, campanhas: camps.length, enviados, vendas, taxaAbertura: ab, criticidade: e.criticidade };
    });
    const totalEnviados = porConta.reduce((s, r) => s + r.enviados, 0);
    const totalVendas = porConta.reduce((s, r) => s + r.vendas, 0);

    // Disparos por canal — envios reais agrupados por dia × canal (email/whatsapp/sms)
    const { data: sends } = await supabase.from('email_events')
      .select('created_at, channel')
      .eq('event', 'send').eq('status', 'enviado')
      .gte('created_at', sinceIso)
      .limit(10000);
    const byDay = { email: {}, whatsapp: {}, sms: {} };
    (sends || []).forEach((r) => {
      const k = String(r.created_at).slice(0, 10);
      const ch = r.channel === 'whatsapp' ? 'whatsapp' : r.channel === 'sms' ? 'sms' : 'email';
      byDay[ch][k] = (byDay[ch][k] || 0) + 1;
    });
    const disparosPorCanal = {
      labels,
      email: keys.map((k) => byDay.email[k] || 0),
      whatsapp: keys.map((k) => byDay.whatsapp[k] || 0),
      sms: keys.map((k) => byDay.sms[k] || 0),
    };

    // Métricas de entrega reais do período
    const countOf = async (builder) => { const { count } = await builder; return count || 0; };
    const evCount = (extra) => {
      let q = supabase.from('email_events').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso);
      Object.entries(extra).forEach(([k, v]) => { q = q.eq(k, v); });
      return countOf(q);
    };
    const [nEnv, nOpen, nClick, nFail] = await Promise.all([
      evCount({ event: 'send', status: 'enviado' }),
      evCount({ event: 'open' }),
      evCount({ event: 'click' }),
      // event='send' exclui falhas de "Enviar teste" (event='send_test') da taxa de
      // bounce do relatório — senão cada teste que falha infla o bounce do cliente.
      evCount({ event: 'send', status: 'falhou' }),
    ]);
    const entrega = {
      abertura: nEnv ? nOpen / nEnv : 0,
      cliques: nEnv ? nClick / nEnv : 0,
      bounce: (nEnv + nFail) ? nFail / (nEnv + nFail) : 0,
    };

    // Campanhas criadas por dia (real)
    const { data: camps } = await supabase.from('campaigns')
      .select('created_at').gte('created_at', sinceIso).limit(2000);
    const campByDay = {};
    (camps || []).forEach((r) => { const k = String(r.created_at).slice(0, 10); campByDay[k] = (campByDay[k] || 0) + 1; });
    const campanhasCriadas = { labels, series: keys.map((k) => campByDay[k] || 0) };

    // Donut: recuperadas por conta (substitui "conversões por canal" — não há
    // atribuição de venda por canal no modelo de dados)
    const recuperadasPorConta = porConta
      .filter((r) => r.vendas > 0)
      .sort((a, b) => b.vendas - a.vendas)
      .slice(0, 6)
      .map((r) => ({ nome: r.conta, valor: r.vendas }));

    // Insights derivados dos dados (sem IA — regras determinísticas)
    const insights = [];
    const criticas = porConta.filter((r) => r.criticidade === 'Crítico');
    if (criticas.length) {
      insights.push({
        tone: 'warning', icon: 'alert-triangle',
        text: criticas.length === 1
          ? `A conta "${criticas[0].conta}" está em criticidade Crítico — priorize revisão dos fluxos e assuntos.`
          : `${criticas.length} contas estão em criticidade Crítico — priorize revisão dos fluxos e assuntos.`,
      });
    }
    const top = [...porConta].sort((a, b) => b.vendas - a.vendas)[0];
    if (top && top.vendas > 0) insights.push({ tone: 'success', icon: 'trending-up', text: `"${top.conta}" lidera em vendas recuperadas no período (${br(top.vendas)}).` });
    if (nEnv > 0) insights.push({ tone: 'info', icon: 'mail-open', text: `Taxa média de abertura no período: ${pct(entrega.abertura)} em ${br(nEnv)} envios.` });
    if (!insights.length) insights.push({ tone: 'info', icon: 'sparkles', text: 'Ainda não há dados suficientes no período para gerar insights.' });

    return { porConta, totalEnviados, totalVendas, range, campanhasCriadas, disparosPorCanal, recuperadasPorConta, entrega, insights };
  },

  // ---- Perfil -------------------------------------------------------------
  async getProfile() {
    const db = await loadDB();
    const me = await currentProfile();
    const user = (me && db.users.find((u) => u.id === me.id)) || null;
    const emp = me ? db.empresas.find((e) => e.id === me.organization_id) : null;
    return { user: user ? clone(user) : null, empresa: emp ? clone(emp) : null, plano: emp ? clone(planoById(db, emp.planoId)) : null };
  },
};
