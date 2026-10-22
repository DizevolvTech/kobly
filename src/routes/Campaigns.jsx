import React, { useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { KoblyAI } from '@/api/ai.js';
import { KoblyMockDB } from '@/api/mockData.js';
import { Badge, Button, Card, DataTable, Icon, IconButton, Input, PageHeader, Select, TemplateCard } from '@/ds';
import { useAsync } from '@/lib/hooks.jsx';
import { AISuggestion, EmptyState, ErrorState, SkeletonTable } from '@/lib/ui.jsx';
import { KoblyFlowBuilder } from '@/routes/FlowBuilder.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Campanhas. Lista de campanhas + galeria "Nova campanha" + orquestra o
// Construtor de fluxo. KoblyCampaigns

// Checklist de ativação — some sozinho quando todos os passos estiverem feitos.
function OnboardingChecklist({ steps }) {
  const total = steps.length;
  const done = steps.filter((s) => s.done).length;
  if (done === total) return null;
  const pct = Math.round((done / total) * 100);
  return (
    <div style={{ background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>Coloque sua primeira campanha no ar</div>
        <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-muted)', flex: 'none' }}>{done} de {total}</div>
      </div>
      <div role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total} aria-label="Progresso da ativação" style={{ height: 6, borderRadius: 'var(--radius-pill)', background: 'var(--surface-sunken)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--grad-accent)', borderRadius: 'var(--radius-pill)', transition: 'width var(--dur-med) var(--ease-out)' }} />
      </div>
      {steps.map((s) => (
        <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name={s.done ? 'check-circle-2' : 'circle'} size={16} style={{ color: s.done ? 'var(--status-success-fg)' : 'var(--text-subtle)', flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 'var(--text-sm)', color: s.done ? 'var(--text-muted)' : 'var(--text-body)', textDecoration: s.done ? 'line-through' : 'none' }}>{s.label}</span>
          {!s.done && s.action && <Button size="sm" variant="ghost" onClick={s.action}>{s.actionLabel}</Button>}
        </div>
      ))}
    </div>
  );
}

function NewCampaign({ templates, brands, onPick, onGenerate, onCancel }) {
  const [sel, setSel] = useState(null);
  const [nome, setNome] = useState('');
  const [nomeTouched, setNomeTouched] = useState(false);
  const [objetivo, setObjetivo] = useState('');
  const [generating, setGenerating] = useState(false);
  // Canais da cadência gerada pela IA — o usuário escolhe se quer e-mail, WhatsApp ou os dois.
  const [canalEmail, setCanalEmail] = useState(true);
  const [canalWhats, setCanalWhats] = useState(false);
  // MARCA-1: marca/produto da campanha — aplica-se tanto à geração por IA quanto à
  // criação manual. '' = marca padrão (1ª da conta). Só aparece se a conta tem marcas.
  const [brandId, setBrandId] = useState('');
  const brandList = brands || [];

  // Selecionar um modelo pré-preenche o nome (se o usuário ainda não digitou o seu).
  function pickTemplate(t) {
    setSel(t.id);
    if (!nomeTouched) setNome(t.blank ? '' : t.nome);
  }
  async function generate() {
    if (!objetivo.trim() || (!canalEmail && !canalWhats)) return;
    setGenerating(true);
    const canais = [...(canalEmail ? ['email'] : []), ...(canalWhats ? ['whatsapp'] : [])];
    try { await onGenerate(objetivo.trim(), canais, brandId || null); } finally { setGenerating(false); }
  }

  const selTpl = templates.find((t) => t.id === sel);
  const finalNome = nome.trim() || (selTpl && !selTpl.blank ? selTpl.nome : 'Nova campanha');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        breadcrumb={[{ label: 'Campanhas', onClick: onCancel }, { label: 'Nova campanha' }]}
        style={{ marginBottom: 0 }}
      >
        Crie uma campanha de recuperação: descreva o objetivo e deixe a IA montar a cadência, ou comece por um modelo.
      </PageHeader>

      {/* Identidade da campanha — logo/cor dos e-mails (não é o HTML da mensagem). */}
      {brandList.length > 0 && (
        <div style={{ maxWidth: 460, background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 16 }}>
          <Select
            label="Identidade desta campanha"
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            options={[{ value: '', label: brandList[0] ? `Padrão (${brandList[0].nome || '1ª marca'})` : 'Marca padrão' }, ...brandList.map((b) => ({ value: b.id, label: b.nome || 'Sem nome' }))]}
          />
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.45 }}>
            Logo e cor nos e-mails gerados. O <b>conteúdo</b> (assunto/HTML) você cria no fluxo, no card <b>Envio de e-mail</b>. Pode trocar a marca depois no construtor.
          </div>
        </div>
      )}

      {/* Gerar com IA (AI-first) */}
      <div className="kbly-ai-card" style={{ background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'inline-flex', width: 32, height: 32, flex: 'none', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-sm)', background: 'var(--accent-soft)', color: 'var(--accent)' }}>
            <Icon name="sparkles" size={17} />
          </span>
          <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--fw-bold)', color: 'var(--text-strong)' }}>Gerar campanha com IA</span>
        </div>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Descreva o objetivo em uma frase. A IA escolhe o gatilho, a cadência e escreve os textos — você revisa e ativa.</p>
        <textarea
          value={objetivo}
          onChange={(e) => setObjetivo(e.target.value)}
          placeholder="Ex.: recuperar quem gerou boleto e não pagou em 2 dias, com um lembrete e uma oferta"
          rows={2}
          style={{ width: '100%', resize: 'vertical', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', color: 'var(--text-body)', background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', boxSizing: 'border-box' }}
        />
        {/* Canais da cadência — o usuário decide se a campanha envia e-mail, WhatsApp ou os dois */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)', fontWeight: 'var(--fw-medium)' }}>Canais:</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--text-sm)', color: 'var(--text-body)', cursor: 'pointer' }}>
            <input type="checkbox" checked={canalEmail} onChange={(e) => setCanalEmail(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
            <Icon name="mail" size={14} style={{ color: 'var(--text-muted)' }} /> E-mail
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--text-sm)', color: 'var(--text-body)', cursor: 'pointer' }}>
            <input type="checkbox" checked={canalWhats} onChange={(e) => setCanalWhats(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
            <Icon name="message-circle" size={14} style={{ color: 'var(--text-muted)' }} /> WhatsApp
          </label>
          {!canalEmail && !canalWhats && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--status-warning-fg)' }}>Escolha pelo menos um canal.</span>
          )}
        </div>
        <div>
          <Button variant="primary" iconLeft="sparkles" loading={generating} disabled={!objetivo.trim() || (!canalEmail && !canalWhats)} onClick={generate}>
            {generating ? 'Gerando campanha…' : 'Gerar campanha com IA'}
          </Button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>ou crie manualmente</span>
        <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
      </div>

      {/* Nome da campanha */}
      <div style={{ maxWidth: 460 }}>
        <Input
          label="Nome da campanha"
          placeholder="Ex.: Recuperação de carrinho — Black Friday"
          value={nome}
          onChange={(e) => { setNome(e.target.value); setNomeTouched(true); }}
        />
      </div>

      {/* Modelo */}
      <div>
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-body)', marginBottom: 10 }}>Modelo</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
          {templates.map((t) => (
            <div key={t.id} className="kbly-lift" style={{ borderRadius: 'var(--radius-md)' }}>
              <TemplateCard icon={t.icone} title={t.nome} description={t.descricao} selected={sel === t.id} onClick={() => pickTemplate(t)} />
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
        {sel && <span style={{ marginInlineEnd: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Será criada como <strong style={{ color: 'var(--text-strong)' }}>{finalNome}</strong></span>}
        <Button variant="ghost" onClick={onCancel}>Cancelar</Button>
        <Button variant="primary" iconLeft="arrow-right" disabled={!sel} onClick={() => onPick(selTpl, finalNome, brandId || null)}>Criar e abrir fluxo</Button>
      </div>
    </div>
  );
}

function KoblyCampaigns() {
  const store = useKobly();
  const DB = KoblyMockDB;
  const variant = 'vertical'; // layout único do builder (o painel de tweaks foi removido)
  const isGestor = store.role === 'Gestor';
  const empresaId = store.session.empresaId;
  const a = useAsync(() => KoblyApi.listCampaigns(empresaId), [store.role]);
  const clients = useAsync(() => (isGestor ? KoblyApi.listClients() : Promise.resolve([])), [store.role]);
  const [mode, setMode] = useState('list'); // list | new | builder
  const [active, setActive] = useState(null);
  const [contaId, setContaId] = useState(null); // conta em foco (Gestor)
  const canEdit = store.can.editCampaign;
  const targetOrgId = isGestor ? contaId : empresaId;
  const campaigns = isGestor
    ? (a.data ? a.data.campaigns.filter((c) => c.empresaId === contaId) : [])
    : (a.data ? a.data.campaigns : []);
  const events = useAsync(() => (targetOrgId ? KoblyApi.getRecentEvents(1, targetOrgId) : Promise.resolve([])), [targetOrgId]);
  // MARCA-1: marcas da conta em foco — alimentam o seletor de marca da nova campanha.
  const brandsA = useAsync(() => (targetOrgId ? KoblyApi.listBrands(targetOrgId) : Promise.resolve([])), [targetOrgId]);
  const hasIntegration = (events.data || []).length > 0;
  const hasCampaign = campaigns.length > 0;
  const hasActive = campaigns.some((c) => c.status === 'Ativa');
  const onboardingSteps = [
    { label: 'Conectar sua integração de checkout', done: hasIntegration, action: () => store.navigate('integracoes'), actionLabel: 'Ir para Integrações' },
    { label: 'Criar sua primeira campanha', done: hasCampaign, action: () => setMode('new'), actionLabel: 'Criar campanha' },
    { label: 'Ativar uma campanha', done: hasActive, action: null, actionLabel: null },
  ];

  // Campanha aberta no construtor sobrevive a recarregar/trocar de aba (o fluxo em edição volta do rascunho).
  const OPEN_KEY = 'kobly:opencampaign';
  useEffect(() => {
    let id = null; try { id = sessionStorage.getItem(OPEN_KEY); } catch { /* sem armazenamento */ }
    if (id) KoblyApi.getCampaign(id).then((c) => { if (c) { setActive(c); setMode('builder'); } }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    try { mode === 'builder' && active ? sessionStorage.setItem(OPEN_KEY, active.id) : (mode === 'list' && sessionStorage.removeItem(OPEN_KEY)); } catch { /* ok */ }
  }, [mode, active]);
  async function openBuilder(id) {
    const c = await KoblyApi.getCampaign(id);
    setActive(c); setMode('builder');
  }
  async function create(tpl, nome, brandId) {
    const c = await KoblyApi.createCampaign(tpl, targetOrgId, nome, brandId);
    store.notify('success', `Campanha "${c.nome}" criada`);
    setActive(c); setMode('builder');
    a.reload();
  }
  async function generateAI(objetivo, canais, brandId) {
    const plan = await KoblyAI.planCampaign(objetivo, canais);
    const c = await KoblyApi.createCampaignFromPlan(plan, targetOrgId, brandId);
    if (!c) { store.notify('danger', 'Não foi possível gerar a campanha'); return; }
    store.notify('success', `Campanha "${c.nome}" gerada pela IA`);
    setActive(c); setMode('builder');
    a.reload();
  }
  async function setStatus(c, status) {
    await KoblyApi.setCampaignStatus(c.id, status);
    a.setData((d) => ({ ...d, campaigns: d.campaigns.map((x) => (x.id === c.id ? { ...x, status } : x)) }));
    store.notify('info', `"${c.nome}" → ${status}`);
  }
  async function removeCampaign(c) {
    if (!confirm(`Excluir a campanha "${c.nome}"? Esta ação não pode ser desfeita.`)) return;
    const { error } = await KoblyApi.deleteCampaign(c.id);
    if (error) { store.notify('danger', error); return; }
    a.setData((d) => ({ ...d, campaigns: d.campaigns.filter((x) => x.id !== c.id) }));
    store.notify('success', `Campanha "${c.nome}" excluída`);
  }

  if (mode === 'builder' && active) {
    return React.createElement(KoblyFlowBuilder, { campaign: active, variant, onBack: () => { setMode('list'); setActive(null); a.reload(); } });
  }
  if (mode === 'new') {
    return <NewCampaign templates={a.data ? a.data.templates : []} brands={brandsA.data || []} onPick={create} onGenerate={generateAI} onCancel={() => setMode('list')} />;
  }

  if (a.status === 'error') return <ErrorState message={a.error} onRetry={a.reload} />;

  // Estado vazio adaptativo: cada bloqueio tem sua própria orientação e CTA.
  const emptyNode = isGestor && !contaId
    ? <EmptyState compact icon="users" title="Selecione uma conta" message="Escolha uma conta de cliente acima para ver e criar campanhas." />
    : !hasIntegration
      ? <EmptyState compact icon="plug-zap" title="Conecte seu checkout" message="Antes de criar campanhas, conecte sua integração de checkout. Depois volte aqui para criar a primeira." action={<Button variant="secondary" iconLeft="arrow-right" onClick={() => store.navigate('integracoes')}>Ir para Integrações</Button>} />
      : <EmptyState compact icon="megaphone" title="Nenhuma campanha ainda" message="Crie sua primeira campanha de recuperação — gere com IA ou comece por um modelo." action={canEdit ? <Button variant="primary" iconLeft="plus" onClick={() => setMode('new')}>Nova campanha</Button> : null} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader action={canEdit && targetOrgId ? <Button variant="primary" iconLeft="plus" onClick={() => setMode('new')}>Nova campanha</Button> : null} style={{ marginBottom: 0 }}>
        Campanhas de recuperação por e-mail. Abra uma campanha para editar o fluxo de automação (gatilhos, tags e envios).
      </PageHeader>
      {isGestor && (
        <Select
          label="Conta"
          value={contaId || ''}
          onChange={(e) => setContaId(e.target.value || null)}
          options={[{ value: '', label: 'Selecione uma conta de cliente' }, ...((clients.data || []).map((c) => ({ value: c.id, label: c.nome })))]}
          style={{ maxWidth: 320 }}
        />
      )}
      {targetOrgId && <OnboardingChecklist steps={onboardingSteps} />}
      <AISuggestion title="Sugestão da IA — campanhas" load={(force) => KoblyAI.suggestForDashboard(store.view, force)} />
      {a.status === 'loading' ? (
        <SkeletonTable />
      ) : (
        <Card pad={false}>
            <DataTable
              rowKey="id"
              zebra
              empty={emptyNode}
              columns={[
                { key: 'nome', header: 'Campanha', render: (r) => (
                  <button onClick={() => openBuilder(r.id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'start', fontFamily: 'var(--font-sans)' }}>
                    <span style={{ display: 'block', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{r.nome}</span>
                    <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{r.fluxo ? r.fluxo.length : 0} etapas · criada {r.criadoEm}</span>
                  </button>
                ) },
                { key: 'status', header: 'Status', render: (r) => <Badge tone={DB.optionSets.StatusCampanha[r.status] || 'neutral'} dot>{r.status}</Badge> },
                { key: 'abertura', header: 'Abertura', align: 'end', render: (r) => KoblyApi.pct(r.stats.taxaAbertura) },
                { key: 'vendas', header: 'Recuperadas', align: 'end', render: (r) => <span style={{ color: r.stats.vendasRecuperadas ? 'var(--status-success-fg)' : 'var(--text-muted)', fontWeight: 'var(--fw-semibold)' }}>{KoblyApi.br(r.stats.vendasRecuperadas)}</span> },
                { key: 'crit', header: 'Criticidade', render: (r) => <Badge tone={DB.optionSets.StatusCriticidade[r.stats.criticidade] || 'neutral'} dot>{r.stats.criticidade}</Badge> },
                { key: 'acao', header: '', align: 'end', width: 150, render: (r) => canEdit ? (
                  <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                    <IconButton icon={r.status === 'Ativa' ? 'pause' : 'play'} size="sm" aria-label="Alternar status" onClick={() => setStatus(r, r.status === 'Ativa' ? 'Pausada' : 'Ativa')} />
                    <IconButton icon="pencil" size="sm" aria-label="Editar fluxo" onClick={() => openBuilder(r.id)} />
                    <IconButton icon="trash-2" size="sm" aria-label="Excluir campanha" onClick={() => removeCampaign(r)} />
                  </div>
                ) : <IconButton icon="eye" size="sm" aria-label="Ver fluxo" onClick={() => openBuilder(r.id)} /> },
              ]}
              rows={campaigns}
            />
        </Card>
      )}
    </div>
  );
}
export { KoblyCampaigns };
