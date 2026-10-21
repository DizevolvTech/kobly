import { useState, useEffect, useRef } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { SUPABASE_URL } from '@/api/supabaseClient.js';
import { KoblyAI } from '@/api/ai.js';
import { KoblyMockDB } from '@/api/mockData.js';
import { Badge, Banner, Button, Card, Icon, IconButton, Input, PageHeader, Select, Spinner, Tabs } from '@/ds';
import { useAsync } from '@/lib/hooks.jsx';
import { Segmented, Modal, PhoneField, ErrorState, SkeletonForm, SkeletonTable, SkeletonRow } from '@/lib/ui.jsx';
import { renderEmail } from '@/lib/emailTemplate.js';
import { useKobly } from '@/store/store.jsx';
import { KoblyEmailEditor } from '@/routes/EmailEditor.jsx';
import { WhatsappMetaTab } from '@/routes/WhatsappMeta.jsx';
import { KoblySmsEditor } from '@/routes/SmsEditor.jsx';

// Kobly — Integrações. Fase 3: seções (Configuração da loja | Postback | Tags | Modelos)
// com sub-abas na loja (Identidade · Remetente · WhatsApp · SMS). Conteúdo de e-mail
// de campanha vive no FlowBuilder, não aqui. KoblyIntegrations

function CopyField({ value, label }) {
  const store = useKobly();
  function copy() {
    try { navigator.clipboard.writeText(value); } catch (e) {}
    store.notify('success', `${label || 'Valor'} copiado`);
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: '6px 6px 6px 12px' }}>
      <code style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</code>
      <IconButton icon="copy" size="sm" aria-label="Copiar" onClick={copy} />
    </div>
  );
}

// ── Eventos suportados (mapeamento event → tipo_evento) ──
const SUPPORTED_EVENTS = [
  { event: 'cart_abandoned', label: 'Carrinho abandonado', description: 'Quando o lead abandona o carrinho de compras' },
  { event: 'payment_approved', label: 'Compra aprovada', description: 'Pagamento confirmado com sucesso' },
  { event: 'payment_refused', label: 'Compra recusada', description: 'Pagamento recusado pelo processador' },
  { event: 'payment_refunded', label: 'Compra reembolsada', description: 'Valor devolvido ao lead' },
  { event: 'payment_chargeback', label: 'Chargeback', description: 'Estorno solicitado pelo comprador' },
  { event: 'payment_canceled', label: 'Compra cancelada', description: 'Pedido cancelado' },
  { event: 'subscription_canceled', label: 'Cancelamento de assinatura', description: 'Assinatura cancelada' },
  { event: 'pix_generated', label: 'Pix gerado', description: 'Código Pix criado para pagamento' },
  { event: 'boleto_generated', label: 'Boleto gerado', description: 'Boleto emitido para pagamento' },
  { event: 'deposit_requested', label: 'Depósito solicitado', description: 'Solicitação de depósito bancário' },
];

// ── Hotmart: aceito nativamente (sem tradução), mapeamento informativo ──
const HOTMART_EVENTS = [
  { event: 'PURCHASE_APPROVED / PURCHASE_COMPLETE', trigger: 'Compra Aprovada' },
  { event: 'PURCHASE_CANCELED / PURCHASE_EXPIRED', trigger: 'Compra cancelada' },
  { event: 'PURCHASE_REFUNDED', trigger: 'Compra Reembolsada' },
  { event: 'PURCHASE_CHARGEBACK', trigger: 'Chargeback' },
  { event: 'PURCHASE_BILLET_PRINTED', trigger: 'Boleto Gerado' },
  { event: 'PURCHASE_OUT_OF_SHOPPING_CART', trigger: 'Abandono de carrinho (nome a confirmar no 1º teste)' },
  { event: 'SUBSCRIPTION_CANCELLATION', trigger: 'Cancelamento de Assinatura' },
];

// ── NexusPayt (família Payt): aceito nativamente, mapeamento informativo status → gatilho ──
const NEXUSPAYT_EVENTS = [
  { event: 'paid', trigger: 'Compra Aprovada' },
  { event: 'refused', trigger: 'Compra Recusada' },
  { event: 'refunded', trigger: 'Compra Reembolsada' },
  { event: 'chargeback', trigger: 'Chargeback' },
  { event: 'canceled', trigger: 'Compra cancelada' },
  { event: 'lost_cart', trigger: 'Abandono de carrinho' },
  { event: 'subscription_canceled', trigger: 'Cancelamento de Assinatura' },
  { event: 'waiting_payment', trigger: 'Pix Gerado / Boleto Gerado (conforme o método)' },
];

// Tempo relativo curto ("agora", "há 12s", "há 3min") pra sessão de teste ao vivo.
function timeAgo(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.round(diffMs / 1000));
  if (s < 5) return 'agora';
  if (s < 60) return `há ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m}min`;
  return `há ${Math.round(m / 60)}h`;
}

const EXAMPLE_PAYLOAD = `{
  "event": "cart_abandoned",
  "email": "lead@email.com",
  "name": "Nome do Lead",
  "product": "Produto Exemplo",
  "value": 197.00,
  "payment_method": "pix",
  "external_id": "tx_123456"
}`;

// ── Aba 1: Postback URL ──
function PostbackTab({ data, empresaId }) {
  const store = useKobly();
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [recentEvents, setRecentEvents] = useState([]);
  const [creating, setCreating] = useState(false);
  const [listening, setListening] = useState(false);
  const [newIds, setNewIds] = useState(() => new Set());
  const [, forceTick] = useState(0); // só pra re-renderizar os "há Xs" durante a sessão
  const pollRef = useRef(null);
  const recentEventsRef = useRef([]);
  recentEventsRef.current = recentEvents;

  // Disparo de evento de teste (contra a própria URL de postback)
  const [testEvent, setTestEvent] = useState('payment_approved');
  const [testEmail, setTestEmail] = useState('');
  const [testName, setTestName] = useState('');
  const [testProduct, setTestProduct] = useState('');
  const [testValue, setTestValue] = useState('');
  const [firing, setFiring] = useState(false);

  // Filtros da lista de eventos
  const [evSearch, setEvSearch] = useState('');
  const [evType, setEvType] = useState('');
  const [evProvider, setEvProvider] = useState('');

  useEffect(() => {
    loadTokens();
    loadRecentEvents();
    setListening(false); // trocou de conta → sessão anterior não vale mais
  }, [empresaId]);

  useEffect(() => {
    if (!listening) { clearInterval(pollRef.current); return undefined; }
    pollRef.current = setInterval(async () => {
      const fresh = await KoblyApi.getRecentEvents(100, empresaId);
      const prevIds = new Set(recentEventsRef.current.map((e) => e.id));
      const arrived = fresh.filter((e) => !prevIds.has(e.id));
      setRecentEvents(fresh);
      if (arrived.length) {
        setNewIds((s) => new Set([...s, ...arrived.map((e) => e.id)]));
        arrived.forEach((e) => {
          store.notify('success', `Novo evento: ${e.tipo_evento}`);
          setTimeout(() => setNewIds((s) => { const n = new Set(s); n.delete(e.id); return n; }), 4000);
        });
      }
      forceTick((n) => n + 1);
    }, 3000);
    return () => clearInterval(pollRef.current);
  }, [listening, empresaId]);

  async function loadTokens() {
    setLoading(true);
    // WEB-1: carrega TODOS os webhooks nomeados da org. Se não existir nenhum,
    // garante um "Token principal" para retrocompatibilidade.
    let list = await KoblyApi.getPostbackTokens();
    if (!list.length) {
      const t = await KoblyApi.getOrCreatePostbackToken(empresaId);
      list = t ? [t] : [];
    }
    setTokens(list);
    setLoading(false);
  }

  async function loadRecentEvents() {
    const events = await KoblyApi.getRecentEvents(100, empresaId);
    setRecentEvents(events);
  }

  // WEB-1: cria um webhook nomeado (ex.: "Hotmart - Produto A").
  const [newName, setNewName] = useState('');
  async function createWebhook() {
    const nome = (newName || '').trim() || 'Novo webhook';
    setCreating(true);
    const r = await KoblyApi.createPostbackToken(nome, empresaId);
    setCreating(false);
    if (r && r.ok) {
      setNewName('');
      await loadTokens();
      store.notify('success', `Webhook "${nome}" criado`);
    } else {
      store.notify('danger', (r && r.error) || 'Não foi possível criar o webhook');
    }
  }
  // WEB-1: renomeia um webhook inline.
  async function renameWebhook(id, nome) {
    const ok = await KoblyApi.renamePostbackToken(id, nome);
    if (ok) { store.notify('success', 'Webhook renomeado'); await loadTokens(); }
  }
  // WEB-1: ativa/desativa um webhook.
  async function toggleWebhook(t) {
    const ok = t.ativo ? await KoblyApi.revokePostbackToken(t.id) : await KoblyApi.activatePostbackToken(t.id);
    if (ok) await loadTokens();
  }
  // WEB-1: exclui um webhook (campanhas vinculadas voltam a "qualquer webhook").
  async function deleteWebhook(t) {
    if (!confirm(`Excluir o webhook "${t.nome}"? Campanhas vinculadas a ele passarão a aceitar qualquer webhook da conta.`)) return;
    const result = await KoblyApi.deletePostbackToken(t.id);
    // API retorna { ok, error } (antes era boolean silencioso → clique "sem ação").
    if (result && result.ok) {
      store.notify('success', 'Webhook excluído');
      await loadTokens();
    } else {
      store.notify('danger', (result && result.error) || 'Não foi possível excluir o webhook');
    }
  }

  // URL do primeiro webhook ativo — usada pelo teste de evento e pelo banner.
  const activeToken = tokens.find((t) => t.ativo);
  const postbackUrl = activeToken ? `${SUPABASE_URL}/functions/v1/postback-receiver?token=${activeToken.token}` : '';

  // Dispara um evento de teste contra a própria URL de postback (dado que VOCÊ escolhe,
  // diferente do botão de teste da Hotmart que manda payload enlatado deles).
  async function fireTestEvent() {
    if (!testEmail.trim() || !postbackUrl) return;
    setFiring(true);
    try {
      const payload = { event: testEvent, email: testEmail.trim() };
      if (testName.trim()) payload.name = testName.trim();
      if (testProduct.trim()) payload.product = testProduct.trim();
      if (testValue !== '' && !Number.isNaN(Number(testValue))) payload.value = Number(testValue);
      const res = await fetch(postbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok && !json.ignored) {
        store.notify('success', `Evento disparado: ${json.tipo_evento}${json.enqueued ? ` · ${json.enqueued} etapa(s) na fila` : ''}`);
        setListening(true); // liga a sessão ao vivo pra você ver o evento chegar
        const fresh = await KoblyApi.getRecentEvents(20, empresaId);
        setRecentEvents(fresh);
      } else {
        store.notify('danger', json.detail || json.reason || 'Falha ao disparar o evento de teste');
      }
    } catch (e) {
      store.notify('danger', 'Erro de rede ao disparar o evento');
    }
    setFiring(false);
  }

  const labelCss = { fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: 'var(--ls-wide)', fontWeight: 'var(--fw-semibold)', marginBottom: 6 };

  if (loading) return <SkeletonForm fields={5} />;

  const hasEvents = recentEvents.length > 0;

  // Filtros client-side sobre os eventos já carregados
  const providersPresent = Array.from(new Set(recentEvents.map((e) => e.provider || 'postback')));
  const typesPresent = Array.from(new Set(recentEvents.map((e) => e.tipo_evento).filter(Boolean)));
  const filteredEvents = recentEvents.filter((e) => {
    if (evType && e.tipo_evento !== evType) return false;
    if (evProvider && (e.provider || 'postback') !== evProvider) return false;
    if (evSearch.trim()) {
      const q = evSearch.toLowerCase();
      if (!`${e.email || ''} ${e.produto || ''}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* WEB-1: Webhooks nomeados (um por produto/plataforma) */}
      <Card icon="link" title="Webhooks de Postback" subtitle="Crie um webhook para cada produto ou plataforma. Cole a URL no painel de checkout — cada campanha pode ser vinculada a um webhook específico.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {loading ? (
            <SkeletonRow />
          ) : tokens.length === 0 ? (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', padding: '8px 0' }}>Nenhum webhook ainda. Crie o primeiro abaixo.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {tokens.map((t) => {
                const url = `${SUPABASE_URL}/functions/v1/postback-receiver?token=${t.token}`;
                return (
                  <div key={t.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        defaultValue={t.nome}
                        onBlur={(e) => { const v = (e.target.value || '').trim(); if (v && v !== t.nome) renameWebhook(t.id, v); }}
                        style={{ flex: 1, fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', background: 'transparent', border: 'none', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', padding: '2px 4px', borderRadius: 'var(--radius-xs)' }}
                      />
                      <Badge tone={t.ativo ? 'success' : 'neutral'} dot>{t.ativo ? 'Ativo' : 'Inativo'}</Badge>
                      <IconButton icon={t.ativo ? 'pause' : 'play'} size="sm" aria-label={t.ativo ? 'Desativar' : 'Ativar'} onClick={() => toggleWebhook(t)} />
                      <IconButton icon="trash-2" size="sm" aria-label="Excluir" onClick={() => deleteWebhook(t)} />
                    </div>
                    <CopyField value={url} label={`URL do webhook ${t.nome}`} />
                  </div>
                );
              })}
            </div>
          )}
          {/* Novo webhook nomeado */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', paddingTop: 4 }}>
            <div style={{ flex: 1 }}>
              <Input
                label="Nome do novo webhook"
                placeholder="Ex.: Hotmart - Produto A"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createWebhook(); }}
              />
            </div>
            <Button variant="secondary" iconLeft="plus" onClick={createWebhook} disabled={creating}>
              {creating ? 'Criando...' : 'Criar webhook'}
            </Button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            <Icon name="info" size={15} style={{ color: 'var(--accent)' }} />
            Cada URL aceita POST com JSON (Hotmart, NexusPayt e contrato genérico). Vincule a campanha ao webhook no Construtor de fluxo.
          </div>
        </div>
      </Card>

      {/* Próximo passo — o que fazer depois de colar a URL na plataforma */}
      {hasEvents ? (
        <Banner
          tone="success"
          icon="check-circle-2"
          title="Recebendo eventos"
          action={<Button size="sm" variant="primary" iconLeft="arrow-right" onClick={() => store.navigate('campanhas')}>Ir para Campanhas</Button>}
        >
          Sua integração está ativa. Próximo passo: crie a campanha que vai reagir a esses eventos.
        </Banner>
      ) : (
        <Banner tone="info" title="Aguardando o primeiro evento">
          Cole a URL acima no painel de checkout (ex.: Hotmart → Webhook) e dispare um evento de teste — assim que chegar, ele aparece aqui embaixo.
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            <Spinner size={13} /> Nenhum evento recebido ainda nesta conta.
          </div>
        </Banner>
      )}

      {/* Disparar evento de teste (dado que VOCÊ escolhe) */}
      <Card icon="zap" title="Disparar evento de teste" subtitle="Dispare um evento com seus próprios dados contra a URL acima — diferente do teste da Hotmart, que manda dados de exemplo fixos.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Select
            label="Tipo de evento"
            value={testEvent}
            onChange={(e) => setTestEvent(e.target.value)}
            options={SUPPORTED_EVENTS.map((ev) => ({ value: ev.event, label: ev.label }))}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="E-mail do lead" placeholder="voce@email.com" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} />
            <Input label="Nome (opcional)" placeholder="Nome do lead" value={testName} onChange={(e) => setTestName(e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="Produto (opcional)" placeholder="Nome do produto" value={testProduct} onChange={(e) => setTestProduct(e.target.value)} />
            <Input label="Valor (opcional)" placeholder="197.00" value={testValue} onChange={(e) => setTestValue(e.target.value)} />
          </div>
          <Button variant="primary" iconLeft="zap" disabled={firing || !testEmail.trim()} onClick={fireTestEvent}>
            {firing ? 'Disparando...' : 'Disparar evento de teste'}
          </Button>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            O evento cai na sua conta como se viesse do checkout — vira lead, dispara campanhas ativas com o gatilho correspondente e aparece na sessão ao vivo abaixo.
          </div>
        </div>
      </Card>

      {/* Hotmart nativo */}
      <Card title="Hotmart" subtitle="Cole a mesma URL acima em Ferramentas → Webhook (versão 2.0.0) — o payload nativo da Hotmart é aceito sem adaptação">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {HOTMART_EVENTS.map((ev) => (
            <div key={ev.event} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--accent)', minWidth: 260 }}>{ev.event}</code>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-strong)' }}>→ {ev.trigger}</div>
            </div>
          ))}
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Eventos fora dessa lista são recebidos e ignorados sem erro — não derrubam o postback.
          </div>
        </div>
      </Card>

      {/* NexusPayt nativo */}
      <Card title="NexusPayt" subtitle="Cole a mesma URL acima no campo de Postback/Webhook da NexusPayt — o payload nativo da família Payt é aceito sem adaptação">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {NEXUSPAYT_EVENTS.map((ev) => (
            <div key={ev.event} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--accent)', minWidth: 260 }}>{ev.event}</code>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-strong)' }}>→ {ev.trigger}</div>
            </div>
          ))}
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            <code>waiting_payment</code> vira "Pix Gerado" ou "Boleto Gerado" conforme o método de pagamento do pedido. Status fora dessa lista são recebidos e ignorados sem erro — não derrubam o postback.
          </div>
        </div>
      </Card>

      {/* Exemplo de payload */}
      <Card title="Exemplo de payload (outras plataformas)" subtitle="Copie e adapte para sua plataforma">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <pre style={{
            background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)', padding: 12, margin: 0,
            fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-body)',
            overflow: 'auto', whiteSpace: 'pre-wrap',
          }}>
            {EXAMPLE_PAYLOAD}
          </pre>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Campos opcionais: <code>name</code>, <code>product</code>, <code>value</code>, <code>payment_method</code>, <code>external_id</code>
          </div>
        </div>
      </Card>

      {/* Sessão de teste ao vivo / últimos eventos */}
      {(recentEvents.length > 0 || listening) && (
        <Card
          title={listening ? 'Sessão de teste ao vivo' : 'Últimos eventos recebidos'}
          subtitle={listening ? 'Atualiza sozinho a cada 3s — dispare eventos na sua plataforma e acompanhe aqui.' : `${recentEvents.length} eventos recentes`}
          action={
            <Button
              size="sm"
              variant={listening ? 'ghost' : 'secondary'}
              iconLeft={listening ? 'square' : 'play'}
              onClick={() => setListening((v) => !v)}
            >
              {listening ? 'Parar sessão' : 'Iniciar sessão de teste'}
            </Button>
          }
        >
          {listening && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-xs)', color: 'var(--status-success-fg)', marginBottom: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'currentColor', display: 'inline-block', animation: 'kbly-pulse 1.4s ease-in-out infinite' }} />
              Ouvindo eventos em tempo real…
            </div>
          )}
          {recentEvents.length === 0 ? (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', padding: '8px 0' }}>Nenhum evento ainda nesta sessão. Dispare um teste na sua plataforma de checkout.</div>
          ) : (
            <>
              {/* Filtros */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                <div style={{ flex: '1 1 200px', minWidth: 160 }}>
                  <Input icon="search" placeholder="Buscar por e-mail ou produto…" value={evSearch} onChange={(e) => setEvSearch(e.target.value)} />
                </div>
                <Select
                  value={evType}
                  onChange={(e) => setEvType(e.target.value)}
                  options={[{ value: '', label: 'Todos os eventos' }, ...typesPresent.map((t) => ({ value: t, label: t }))]}
                  style={{ minWidth: 170 }}
                />
                {providersPresent.length > 1 && (
                  <Select
                    value={evProvider}
                    onChange={(e) => setEvProvider(e.target.value)}
                    options={[{ value: '', label: 'Todas as origens' }, ...providersPresent.map((p) => ({ value: p, label: p }))]}
                    style={{ minWidth: 150 }}
                  />
                )}
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', marginBottom: 6 }}>
                {filteredEvents.length} de {recentEvents.length} evento(s)
              </div>
              {filteredEvents.length === 0 ? (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', padding: '8px 0' }}>Nenhum evento corresponde aos filtros.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                  {filteredEvents.map((ev) => (
                    <div
                      key={ev.id}
                      className={newIds.has(ev.id) ? 'kbly-flash' : undefined}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 8px', borderBottom: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    >
                      <Badge tone={KoblyMockDB.eventTone[ev.tipo_evento] || 'neutral'} dot>{ev.tipo_evento}</Badge>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.email}</div>
                        {ev.produto && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{ev.produto}{ev.valor_produto ? ` — R$ ${ev.valor_produto}` : ''}</div>}
                      </div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textAlign: 'right', flex: 'none' }}>
                        <div>{ev.provider || 'postback'}</div>
                        <div>{timeAgo(ev.created_at)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Card>
      )}
    </div>
  );
}

// ── Aba: Modelos reutilizáveis (secundária) ──
// Biblioteca avançada. Caminho principal = card "Envio de e-mail" na campanha.
// Aqui o usuário guarda/copia conteúdo; o vínculo à etapa é no FlowBuilder.
function EmailTemplatesTab({ data, reload, empresaId }) {
  const store = useKobly();
  const [editor, setEditor] = useState(null);
  const brandsA = useAsync(() => KoblyApi.listBrands(empresaId), [empresaId]);
  const defaultBrand = (brandsA.data && brandsA.data[0]) || null;
  const emails = data.emails || [];

  function openNew() {
    setEditor({ titulo: '', assunto: '', remetente: '', corpoHtml: '' });
  }
  function openEdit(email) {
    setEditor(email);
  }
  async function duplicate(src) {
    const { error, id } = await KoblyApi.createEmail({
      titulo: `${src.titulo || 'Modelo'} (cópia)`,
      assunto: src.assunto || '',
      remetente: src.remetente || '',
      corpoHtml: src.corpoHtml || '',
    }, empresaId);
    if (error) { store.notify('danger', error); return; }
    store.notify('success', 'Modelo duplicado — use-o no card da campanha (Copiar de um modelo)');
    reload();
    return id;
  }

  async function saveEmail(p) {
    if (!p) return { error: 'Dados inválidos' };
    if (p.id) {
      const { error } = await KoblyApi.updateEmail(p.id, {
        titulo: p.titulo, assunto: p.assunto, remetente: p.remetente, corpoHtml: p.corpoHtml,
      });
      if (error) return { error };
      reload();
      return { error: null };
    }
    const { error, id } = await KoblyApi.createEmail({
      titulo: p.titulo, assunto: p.assunto, remetente: p.remetente, corpoHtml: p.corpoHtml,
    }, empresaId);
    if (error) return { error };
    reload();
    return { error: null, id };
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        icon="library"
        title="Modelos reutilizáveis (avançado)"
        subtitle="Biblioteca de conteúdo. O caminho principal é criar o e-mail no fluxo da campanha — lá a marca da campanha é aplicada no preview e na IA."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Banner tone="info">
            <b>Use esta aba só se</b> quiser guardar um HTML para copiar em várias campanhas.
            No dia a dia: <b>Campanhas → abrir fluxo → card Envio de e-mail → Criar e-mail</b>.
          </Banner>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Button variant="primary" size="sm" iconLeft="git-branch" onClick={() => store.navigate('campanhas')}>
              Ir para campanhas
            </Button>
            <Button variant="secondary" size="sm" iconLeft="plus" onClick={openNew}>
              Novo modelo na biblioteca
            </Button>
          </div>
        </div>
      </Card>

      {emails.length === 0 && (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)', border: '1px dashed var(--border-default)', borderRadius: 'var(--radius-md)' }}>
          Nenhum modelo na biblioteca. Crie e-mails no fluxo da campanha — eles também aparecem aqui se quiser reutilizar.
        </div>
      )}

      {emails.map((e) => (
        <Card
          key={e.id}
          icon="mail"
          title={e.titulo}
          subtitle={e.assunto || 'Sem assunto'}
          action={(
            <div style={{ display: 'flex', gap: 6 }}>
              <Button size="sm" variant="ghost" iconLeft="copy" onClick={() => duplicate(e)}>Duplicar</Button>
              <Button size="sm" variant="ghost" iconLeft="pencil" onClick={() => openEdit(e)}>Editar</Button>
            </div>
          )}
        >
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Nome do remetente: {e.remetente || '—'} · no fluxo: <b>Copiar de um modelo</b>
          </div>
        </Card>
      ))}

      {editor !== null && (
        <KoblyEmailEditor
          email={editor}
          brand={defaultBrand}
          brandContext="biblioteca"
          onClose={() => setEditor(null)}
          onSave={saveEmail}
        />
      )}
    </div>
  );
}

// ── Aba: WhatsApp — API oficial da Meta (ver WhatsappMeta.jsx) ──
// ── Aba: SMS (GTI SMS) — templates + envio de teste ──
function SmsTab({ empresaId }) {
  const store = useKobly();
  const msgs = useAsync(() => KoblyApi.listSmsMessages(), [empresaId]);
  const testPhoneA = useAsync(() => KoblyApi.getWhatsappTestPhone(), []);
  const [testPhone, setTestPhone] = useState('');
  const [phoneLoaded, setPhoneLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testMsgId, setTestMsgId] = useState(''); // template a enviar ('' = mensagem padrão)
  const [editor, setEditor] = useState(null);

  // Reaproveita o número de teste do perfil (mesmo campo do WhatsApp).
  useEffect(() => {
    if (phoneLoaded || !testPhoneA.data) return;
    if (testPhoneA.data.phone) setTestPhone(testPhoneA.data.phone);
    setPhoneLoaded(true);
  }, [testPhoneA.data, phoneLoaded]);

  async function sendTest() {
    if (!testPhone.trim()) return;
    setSending(true);
    setTestResult(null);
    await KoblyApi.saveWhatsappTestPhone(testPhone);
    const selected = testMsgId ? (msgs.data || []).find((m) => m.id === testMsgId) : null;
    const message = selected
      ? (selected.corpoTexto || selected.titulo || '')
      : 'Teste de SMS da KOBLY — sua integração está funcionando.';
    const r = await KoblyApi.sendTestSms({ to: testPhone.trim(), message });
    setSending(false);
    if (r.error) {
      setTestResult({ ok: false, msg: r.error });
      store.notify('danger', r.error);
    } else {
      setTestResult({ ok: true, msg: `SMS enviado${r.segments ? ` (${r.segments} segmento(s))` : ''} — confira o celular.` });
      store.notify('success', 'SMS de teste enviado');
    }
  }

  async function saveMsg(p) {
    const r = await KoblyApi.saveSmsMessage({ id: p.id || null, titulo: p.titulo, corpoTexto: p.corpoTexto }, empresaId);
    if (r.error) return { error: r.error };
    msgs.reload();
    return { error: null, id: r.id };
  }

  const messages = (msgs.data || []).filter((m) => !empresaId || m.empresaId === empresaId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Card icon="smartphone" title="SMS" subtitle="As credenciais do provedor ficam no servidor (Vault). Envie um teste para validar.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            <Icon name="info" size={15} style={{ color: 'var(--accent)' }} />
            O número de teste é o mesmo do WhatsApp (salvo no seu perfil).
          </div>
          {messages.length > 0 && (
            <div style={{ maxWidth: 380 }}>
              <Select
                label="Mensagem a testar"
                value={testMsgId}
                onChange={(e) => setTestMsgId(e.target.value)}
                options={[{ value: '', label: 'Mensagem padrão de teste' }, ...messages.map((m) => ({ value: m.id, label: m.titulo || 'Mensagem' }))]}
              />
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 280px', maxWidth: 380 }}>
              <PhoneField label="Telefone de teste" value={testPhone} onChange={setTestPhone} />
            </div>
            <Button variant="primary" iconLeft="send" disabled={sending || testPhone.replace(/\D/g, '').length < 10} onClick={sendTest}>
              {sending ? 'Enviando…' : 'Enviar teste'}
            </Button>
          </div>
          {testResult && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--text-sm)', color: testResult.ok ? 'var(--status-success-fg)' : 'var(--status-danger-fg)' }}>
              <Icon name={testResult.ok ? 'check-circle-2' : 'alert-triangle'} size={15} style={{ flex: 'none' }} />
              {testResult.msg}
            </div>
          )}
        </div>
      </Card>

      {messages.map((m) => (
        <Card key={m.id} icon="smartphone" title={m.titulo} subtitle="Mensagem de SMS"
          action={<Button size="sm" variant="ghost" iconLeft="pencil" onClick={() => setEditor(m)}>Editar</Button>}>
          <div style={{
            maxWidth: 460, background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)',
            borderRadius: '4px 14px 14px 14px', padding: '10px 13px', fontSize: 'var(--text-sm)',
            color: 'var(--text-strong)', lineHeight: 'var(--lh-normal)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          }}>
            {m.corpoTexto}
          </div>
        </Card>
      ))}
      <Button variant="secondary" iconLeft="plus" onClick={() => setEditor({ titulo: '', corpoTexto: '' })}>Nova mensagem de SMS</Button>

      {editor !== null && (
        <KoblySmsEditor message={editor} onClose={() => setEditor(null)} onSave={saveMsg} />
      )}
    </div>
  );
}

// ── Aba: Domínio de envio (Resend) — remetente customizado ──
function DomainTab({ empresaId }) {
  const store = useKobly();
  const a = useAsync(() => KoblyApi.listSendingDomains(empresaId), [empresaId]);
  const [name, setName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    const { error } = await KoblyApi.createSendingDomain({
      name: name.trim().toLowerCase(),
      fromEmail: fromEmail.trim() || undefined,
    }, empresaId);
    setCreating(false);
    if (error) { store.notify('danger', typeof error === 'string' ? error : 'Falha ao criar domínio'); return; }
    store.notify('success', 'Domínio criado — adicione os registros DNS abaixo');
    setName(''); setFromEmail('');
    a.reload();
  }
  async function verify(id) {
    setBusyId(id);
    const { error, verified } = await KoblyApi.verifySendingDomain(id);
    setBusyId(null);
    if (error) { store.notify('danger', error); return; }
    store.notify(verified ? 'success' : 'warning', verified ? 'Domínio verificado!' : 'Ainda pendente — confira o DNS (pode levar alguns minutos)');
    a.reload();
  }
  async function remove(id, url) {
    if (!confirm(`Remover o domínio ${url}?`)) return;
    setBusyId(id);
    const { error } = await KoblyApi.deleteSendingDomain(id);
    setBusyId(null);
    if (error) { store.notify('danger', error); return; }
    store.notify('success', 'Domínio removido');
    a.reload();
  }

  const domains = a.data?.domains || [];
  // Remetente EFETIVO (mesma prioridade do worker): domínio próprio verificado >
  // subdomínio automático da plataforma > remetente da plataforma. Zero setup por padrão.
  const senderLocal = a.data?.senderLocal;
  const sendingDomain = a.data?.sendingDomain;
  const verifiedDomain = domains.find((d) => (d.validado || d.status === 'verified') && d.id_resend && !String(d.id_resend).startsWith('sg'));
  const effectiveFrom = verifiedDomain
    ? (verifiedDomain.from_email || (verifiedDomain.url ? `contato@${verifiedDomain.url}` : null))
    : (sendingDomain && senderLocal ? `${senderLocal}@${sendingDomain}` : null);
  const effectiveLabel = effectiveFrom || 'contato@koblay.io';
  const effectiveTipo = verifiedDomain ? 'seu domínio verificado'
    : (effectiveFrom ? 'subdomínio automático · sem DNS' : 'remetente da plataforma');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Card icon="send" title="Remetente e domínio" subtitle="De onde o e-mail SAI (endereço From) — não é logo nem HTML. Identidade visual fica em Identidade dos e-mails.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="kbly-num" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)', color: 'var(--text-strong)', background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: '6px 10px' }}>{effectiveLabel}</span>
            <Badge tone={verifiedDomain || effectiveFrom ? 'success' : 'neutral'} dot>{effectiveTipo}</Badge>
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Usar o <b>seu próprio domínio</b> no From é <b>opcional</b>. Logo e cores da loja se configuram em <b>Identidade dos e-mails</b>.
          </div>
        </div>
      </Card>

      <Card icon="globe" title="Domínio próprio (opcional)" subtitle="Só se quiser o From no SEU domínio (ex.: contato@sualoja.com.br). Requer DNS.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Banner tone="info">
            Após criar o domínio, adicione os registros DNS no seu provedor (Registro.br, Cloudflare, etc.). Depois clique em Verificar.
          </Banner>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'flex-end' }}>
            <Input label="Domínio" placeholder="envio.sualoja.com.br" value={name} onChange={(e) => setName(e.target.value)} />
            <Input label="E-mail remetente" placeholder="contato@envio.sualoja.com.br" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} />
            <Button variant="primary" iconLeft="plus" loading={creating} disabled={creating || !name.trim()} onClick={create}>
              {creating ? 'Criando…' : 'Adicionar'}
            </Button>
          </div>
        </div>
      </Card>

      {a.loading && <SkeletonForm fields={2} />}
      {a.data?.error && <Banner tone="danger">{a.data.error}</Banner>}

      {domains.map((d) => {
        const verified = d.validado || d.status === 'verified';
        const records = d.domain_dns_records || d.registros || [];
        return (
          <Card key={d.id} icon="mail" title={d.url}
            subtitle={d.from_email || d.fromEmail || '—'}
            action={<Badge tone={verified ? 'success' : 'warning'} dot>{verified ? 'Verificado' : 'Pendente'}</Badge>}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {records.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                        <th style={{ padding: '6px 8px' }}>Tipo</th>
                        <th style={{ padding: '6px 8px' }}>Host</th>
                        <th style={{ padding: '6px 8px' }}>Valor</th>
                        <th style={{ padding: '6px 8px' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((r, i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '6px 8px', color: 'var(--text-strong)' }}>{r.tipo}</td>
                          <td style={{ padding: '6px 8px', color: 'var(--text-body)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.host}>{r.host}</td>
                          <td style={{ padding: '6px 8px', color: 'var(--text-body)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.valor}>{r.valor}</td>
                          <td style={{ padding: '6px 8px' }}><Badge tone={r.status === 'verificado' ? 'success' : 'neutral'}>{r.status}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <Button size="sm" variant="secondary" iconLeft="refresh-cw" loading={busyId === d.id} disabled={busyId === d.id} onClick={() => verify(d.id)}>
                  Verificar DNS
                </Button>
                <Button size="sm" variant="ghost" iconLeft="trash-2" disabled={busyId === d.id} onClick={() => remove(d.id, d.url)}>
                  Remover
                </Button>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ── Aba 3: Tags ──
function TagsTab({ data, reload }) {
  const store = useKobly();
  const DB = KoblyMockDB;
  const [nome, setNome] = useState('');
  const [tipo, setTipo] = useState('Abandono de carrinho');
  async function create() {
    if (!nome.trim()) return;
    const t = await KoblyApi.createTag({ nome, descricao: '', tipoEvento: tipo });
    store.notify('success', `Tag "${t.nome}" criada`);
    setNome('');
    reload();
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16, alignItems: 'start' }}>
      <Card icon="tag" title="Tags da conta" subtitle="Disparadas por tipo de evento do checkout" pad={false}>
        <div style={{ padding: 8 }}>
          {data.tags.map((t) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
              <div>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{t.nome}</div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{t.descricao || '—'}</div>
              </div>
              <Badge tone={DB.eventTone[t.tipoEvento] || 'neutral'} dot>{t.tipoEvento}</Badge>
            </div>
          ))}
        </div>
      </Card>
      <Card icon="plus" title="Nova tag">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input label="Nome da tag" placeholder="Ex.: Cliente VIP" value={nome} onChange={(e) => setNome(e.target.value)} />
          <Select label="Tipo de evento" value={tipo} onChange={(e) => setTipo(e.target.value)} options={DB.optionSets.TipoEvento} />
          <Button variant="primary" iconLeft="plus" disabled={!nome.trim()} onClick={create}>Criar tag</Button>
        </div>
      </Card>
    </div>
  );
}

// ── Componente principal ──
// ── Aba: Identidade dos e-mails (white-label) ──
// MARCA-1: fonte única de marcas da conta (1:N). Aqui é só "quem sou" (logo/cor/tema),
// não o HTML da mensagem nem o From técnico.
function BrandTab({ empresaId }) {
  return (
    <Card
      icon="layers"
      title="Identidade dos e-mails"
      subtitle="Logo, cor e tema da loja/produto. Em cada campanha você escolhe qual marca usar; o assunto e o HTML ficam no card do fluxo."
    >
      <BrandsList empresaId={empresaId} />
    </Card>
  );
}

// MARCA-1: lista de marcas da org com criar/editar/excluir.
function BrandsList({ empresaId, onSaved }) {
  const store = useKobly();
  const a = useAsync(() => KoblyApi.listBrands(empresaId), [empresaId]);
  const [editing, setEditing] = useState(null);
  const [nome, setNome] = useState('');
  const [cor, setCor] = useState('#ff6800');
  const [logoUrl, setLogoUrl] = useState('');
  const [modo, setModo] = useState('dark');
  const [linkLoja, setLinkLoja] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  function openNew() {
    setEditing('new');
    setNome(''); setCor('#ff6800'); setLogoUrl(''); setModo('dark'); setLinkLoja('');
  }
  function openEdit(b) {
    setEditing(b.id);
    setNome(b.nome || ''); setCor(b.cor || '#ff6800'); setLogoUrl(b.logo_url || ''); setModo(b.modo === 'light' ? 'light' : 'dark'); setLinkLoja(b.link_loja || '');
  }
  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setUploading(true);
    const r = await KoblyApi.uploadLogo(file, empresaId);
    setUploading(false);
    if (r && r.url) { setLogoUrl(r.url); store.notify('success', 'Logo enviado'); }
    else store.notify('danger', 'Falha ao enviar o logo');
  }
  async function save() {
    if (!nome.trim()) return;
    setSaving(true);
    if (editing === 'new') {
      const { error } = await KoblyApi.createBrand({ nome, cor, logoUrl, modo, linkLoja }, empresaId);
      store.notify(error ? 'danger' : 'success', error || 'Marca criada');
    } else {
      const { error } = await KoblyApi.updateBrand(editing, { nome, cor, logoUrl, modo, linkLoja });
      store.notify(error ? 'danger' : 'success', error || 'Marca atualizada');
    }
    setSaving(false);
    if (onSaved) onSaved();
    setEditing(null);
    a.reload();
  }
  async function remove(b) {
    if (!confirm(`Excluir a marca "${b.nome || 'Sem nome'}"? Campanhas vinculadas voltarão à marca padrão.`)) return;
    const { error } = await KoblyApi.deleteBrand(b.id);
    store.notify(error ? 'danger' : 'success', error || 'Marca excluída');
    if (!error) a.reload();
  }

  if (a.status === 'loading') return <SkeletonRow />;
  const list = a.data || [];

  // Prévia ao vivo do e-mail com a marca em edição — reflete logo, cor e tema.
  const previewHtml = renderEmail({
    brand: { name: nome || 'Sua Loja', logoUrl, color: cor, mode: modo },
    preheader: 'Prévia da sua marca',
    blocks: [
      { type: 'hero', eyebrow: 'Recuperação', title: 'Você esqueceu algo no carrinho', text: 'Finalize sua compra e garanta seu pedido.' },
      { type: 'button', label: 'Voltar ao carrinho', href: linkLoja || '#' },
      { type: 'coupon', code: 'VOLTA10', note: '10% de desconto por tempo limitado' },
    ],
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {list.length === 0 && !editing && (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Nenhuma marca ainda. Crie a primeira abaixo.</div>
      )}
      {list.map((b) => (
        <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
          <div style={{ width: 36, height: 36, borderRadius: 'var(--radius-sm)', flex: 'none', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-card)' }}>
            {b.logo_url ? <img src={b.logo_url} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <span style={{ width: 28, height: 28, borderRadius: 'var(--radius-xs)', background: b.cor || '#ff6800' }} />}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', fontSize: 'var(--text-sm)' }}>{b.nome || 'Sem nome'}</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{b.modo === 'light' ? 'Tema claro' : 'Tema escuro'}{b.link_loja ? ` · ${b.link_loja}` : ''}</div>
          </div>
          <IconButton icon="pencil" size="sm" aria-label="Editar marca" onClick={() => openEdit(b)} />
          <IconButton icon="trash-2" size="sm" aria-label="Excluir marca" onClick={() => remove(b)} />
        </div>
      ))}
      {editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14, background: 'var(--surface-card)', border: '1px solid var(--border-accent)', borderRadius: 'var(--radius-sm)' }}>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: 'var(--ls-wide)', fontWeight: 'var(--fw-semibold)', marginBottom: 8 }}>Logo</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 64, height: 64, borderRadius: 'var(--radius-md)', background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flex: 'none' }}>
                {logoUrl ? <img src={logoUrl} alt="logo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <Icon name="image" size={20} style={{ color: 'var(--text-subtle)' }} />}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input ref={fileRef} type="file" accept="image/*" onChange={onFile} style={{ display: 'none' }} />
                <Button variant="secondary" size="sm" iconLeft="upload" disabled={uploading} onClick={() => fileRef.current && fileRef.current.click()}>{uploading ? 'Enviando...' : 'Enviar logo'}</Button>
                {logoUrl && <button onClick={() => setLogoUrl('')} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 'var(--text-xs)', cursor: 'pointer', textAlign: 'start', padding: 0 }}>Remover logo</button>}
              </div>
            </div>
          </div>
          <Input label="Nome da marca" placeholder="Ex.: Produto Premium" value={nome} onChange={(e) => setNome(e.target.value)} />
          <div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: 'var(--ls-wide)', fontWeight: 'var(--fw-semibold)', marginBottom: 8 }}>Cor da marca</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="color" value={cor} onChange={(e) => setCor(e.target.value)} style={{ width: 44, height: 34, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', background: 'none', cursor: 'pointer', padding: 2 }} />
              <Input value={cor} onChange={(e) => setCor(e.target.value)} style={{ maxWidth: 130 }} />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: 'var(--ls-wide)', fontWeight: 'var(--fw-semibold)', marginBottom: 8 }}>Tema do e-mail</div>
            <Segmented value={modo} onChange={setModo} options={[{ value: 'dark', label: 'Escuro' }, { value: 'light', label: 'Claro' }]} />
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 6 }}>Define o fundo dos e-mails enviados com esta marca.</div>
          </div>
          <Input label="URL de checkout (opcional)" placeholder="https://minhaloja.com/checkout" value={linkLoja} onChange={(e) => setLinkLoja(e.target.value)} />
          <div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: 'var(--ls-wide)', fontWeight: 'var(--fw-semibold)', marginBottom: 8 }}>Prévia do e-mail</div>
            <div style={{ borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
              <iframe title="preview" srcDoc={previewHtml} style={{ width: '100%', height: 420, border: 'none', display: 'block', background: modo === 'light' ? '#f4f4f5' : '#000' }} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancelar</Button>
            <Button variant="primary" size="sm" iconLeft="check" loading={saving} disabled={saving || !nome.trim()} onClick={save}>{saving ? 'Salvando…' : 'Salvar'}</Button>
          </div>
        </div>
      )}
      {!editing && <Button variant="secondary" size="sm" iconLeft="plus" onClick={openNew}>Nova marca</Button>}
    </div>
  );
}

// Fase 3 — IA em 2 níveis:
//   Seção  →  Configuração da loja | Postback | Tags | Modelos
//   Sub    →  (só em Config) Identidade | Remetente | WhatsApp | SMS
// Conteúdo de e-mail de campanha NÃO mora aqui — fica no FlowBuilder.
const SECTIONS = [
  { value: 'loja', label: 'Configuração da loja', icon: 'store', help: 'Identidade, remetente e canais' },
  { value: 'postback', label: 'Postback', icon: 'webhook', help: 'Webhooks de checkout' },
  { value: 'tags', label: 'Tags', icon: 'tag', help: 'Marcadores de lead' },
  { value: 'emails', label: 'Modelos', icon: 'library', help: 'Biblioteca avançada' },
];
const LOJA_SUBS = [
  { value: 'marca', label: 'Identidade', icon: 'palette' },
  { value: 'dominio', label: 'Remetente', icon: 'globe' },
  { value: 'whatsapp', label: 'WhatsApp', icon: 'message-circle' },
  { value: 'sms', label: 'SMS', icon: 'smartphone' },
];

function KoblyIntegrations() {
  const store = useKobly();
  const isGestor = store.role === 'Gestor';
  const a = useAsync(() => KoblyApi.getIntegrations(), [store.role]);
  const clients = useAsync(() => (isGestor ? KoblyApi.listClients() : Promise.resolve([])), [store.role]);
  const [section, setSection] = useState('loja');
  const [lojaSub, setLojaSub] = useState('marca');
  const [contaId, setContaId] = useState(null);
  const empresaId = isGestor ? contaId : store.session.empresaId;

  if (a.status === 'loading') return <SkeletonTable rows={4} />;
  if (a.status === 'error') return <ErrorState message={a.error} onRetry={a.reload} />;

  const sectionHelp = (SECTIONS.find((s) => s.value === section) || {}).help || '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader tabs={<Tabs value={section} onChange={setSection} options={SECTIONS.map(({ value, label, icon }) => ({ value, label, icon }))} />}>
        {section === 'loja'
          ? 'Tudo que define a cara e o envio da loja: identidade visual, From e canais. O texto do e-mail de recuperação fica na campanha.'
          : section === 'emails'
            ? 'Biblioteca opcional de HTML. Preferência: criar o e-mail no card da campanha.'
            : sectionHelp || 'Integrações da conta.'}
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

      {isGestor && !contaId ? (
        <div style={{ color: 'var(--text-muted)', padding: 28 }}>Selecione uma conta de cliente para ver as integrações.</div>
      ) : (
        <>
          {section === 'loja' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Mapa mental das 3 camadas — sempre visível no setup da loja */}
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10,
              }}>
                {[
                  { n: '1', title: 'Identidade', desc: 'Logo, cor, tema', sub: 'marca', icon: 'palette' },
                  { n: '2', title: 'Remetente', desc: 'De onde o e-mail sai', sub: 'dominio', icon: 'globe' },
                  { n: '3', title: 'Conteúdo', desc: 'Assunto e HTML', sub: null, icon: 'mail', cta: true },
                ].map((item) => (
                  <button
                    key={item.n}
                    type="button"
                    onClick={() => {
                      if (item.cta) store.navigate('campanhas');
                      else if (item.sub) setLojaSub(item.sub);
                    }}
                    style={{
                      textAlign: 'start', cursor: 'pointer', fontFamily: 'var(--font-sans)',
                      background: lojaSub === item.sub ? 'var(--accent-soft)' : 'var(--surface-card)',
                      border: `1px solid ${lojaSub === item.sub ? 'var(--accent)' : 'var(--border-subtle)'}`,
                      borderRadius: 'var(--radius-md)', padding: '12px 14px',
                      display: 'flex', gap: 10, alignItems: 'flex-start',
                    }}
                  >
                    <span style={{
                      display: 'inline-flex', width: 28, height: 28, flex: 'none', alignItems: 'center', justifyContent: 'center',
                      borderRadius: 'var(--radius-sm)', background: item.cta ? 'var(--accent-soft)' : 'var(--surface-sunken)',
                      color: item.cta ? 'var(--accent)' : 'var(--text-muted)', fontSize: 'var(--text-xs)', fontWeight: 700,
                    }}>
                      {item.cta ? <Icon name={item.icon} size={14} /> : item.n}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{item.title}</span>
                      <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                        {item.desc}{item.cta ? ' → campanhas' : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </div>

              <Tabs value={lojaSub} onChange={setLojaSub} options={LOJA_SUBS} />

              {lojaSub === 'marca' && <BrandTab empresaId={empresaId} />}
              {lojaSub === 'dominio' && <DomainTab empresaId={empresaId} />}
              {lojaSub === 'whatsapp' && <WhatsappMetaTab empresaId={empresaId} />}
              {lojaSub === 'sms' && <SmsTab empresaId={empresaId} />}
            </div>
          )}

          {section === 'postback' && <PostbackTab data={a.data} empresaId={empresaId} />}
          {section === 'tags' && <TagsTab data={a.data} reload={a.reload} />}
          {section === 'emails' && <EmailTemplatesTab data={a.data} reload={a.reload} empresaId={empresaId} />}
        </>
      )}
    </div>
  );
}
export { KoblyIntegrations };
