// Aba WhatsApp (API oficial da Meta). Cada empresa conecta o PRÓPRIO número: os disparos
// saem do WhatsApp dela. A API oficial só inicia conversa com MODELOS aprovados pela Meta.
import { useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { Badge, Banner, Button, Card, Icon, Input, Select, Spinner } from '@/ds';
import { useAsync } from '@/lib/hooks.jsx';
import { PhoneField } from '@/lib/ui.jsx';
import { useKobly } from '@/store/store.jsx';

const TPL_TONE = { APPROVED: 'success', PENDING: 'warning', IN_APPEAL: 'warning', REJECTED: 'danger', PAUSED: 'danger', DISABLED: 'danger' };
const TPL_LABEL = { APPROVED: 'Aprovado', PENDING: 'Em análise', IN_APPEAL: 'Em recurso', REJECTED: 'Rejeitado', PAUSED: 'Pausado', DISABLED: 'Desativado' };
const QUALITY = { GREEN: ['success', 'Qualidade alta'], YELLOW: ['warning', 'Qualidade média'], RED: ['danger', 'Qualidade baixa'], UNKNOWN: ['neutral', 'Qualidade em avaliação'] };

function CopyRow({ label, value }) {
  const store = useKobly();
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
      <div style={{ flex: 1 }}><Input label={label} value={value} readOnly onChange={() => {}} /></div>
      <Button variant="secondary" size="sm" iconLeft="copy" onClick={() => { navigator.clipboard?.writeText(value); store.notify('success', 'Copiado'); }}>Copiar</Button>
    </div>
  );
}

function ConnectForm({ empresaId, onDone }) {
  const store = useKobly();
  const [f, setF] = useState({ waba_id: '', phone_number_id: '', access_token: '', app_secret: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const ready = /^\d{5,25}$/.test(f.waba_id.trim()) && /^\d{5,25}$/.test(f.phone_number_id.trim()) && f.access_token.trim().length >= 20;
  async function connect() {
    setBusy(true); setErr(null);
    const r = await KoblyApi.whatsappAccount('connect', f, empresaId);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    store.notify('success', 'WhatsApp conectado');
    onDone(r);
  }
  return (
    <Card icon="message-circle" title="Conectar o WhatsApp da sua empresa" subtitle="Os envios saem do número que você conectar aqui, pela API oficial da Meta.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
        <Banner tone="info" title="Onde encontrar">
          No painel da Meta (developers.facebook.com → seu app → WhatsApp → Configuração da API) ficam o <b>ID do número</b> e o <b>ID da conta do WhatsApp Business</b>.
          O <b>token</b> deve ser permanente (usuário do sistema), com as permissões whatsapp_business_messaging e whatsapp_business_management.
        </Banner>
        <Input label="ID da conta do WhatsApp Business" value={f.waba_id} onChange={set('waba_id')} placeholder="somente números" />
        <Input label="ID do número de telefone" value={f.phone_number_id} onChange={set('phone_number_id')} placeholder="somente números" />
        <Input label="Token de acesso permanente" type="password" value={f.access_token} onChange={set('access_token')} placeholder="EAAG…" />
        <Input label="Segredo do app (opcional, recomendado)" type="password" value={f.app_secret} onChange={set('app_secret')} placeholder="usado para validar os avisos de entrega" />
        {err && <Banner tone="danger">{err}</Banner>}
        <div><Button variant="primary" iconLeft="plug" disabled={!ready || busy} onClick={connect}>{busy ? 'Conferindo na Meta…' : 'Conectar'}</Button></div>
      </div>
    </Card>
  );
}

function NewTemplate({ empresaId, onClose, onCreated }) {
  const store = useKobly();
  const [f, setF] = useState({ name: '', category: 'MARKETING', body: '', ex: '', url: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function create() {
    setBusy(true); setErr(null);
    const examples = f.ex.split('|').map((x) => x.trim()).filter(Boolean);
    const buttons = f.url.trim() ? [{ type: 'URL', text: 'Finalizar compra', url: f.url.trim(), example: 'abc' }] : [];
    const r = await KoblyApi.whatsappAccount('create_template', { name: f.name, category: f.category, body: f.body, examples, buttons, language: 'pt_BR' }, empresaId);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    store.notify('success', 'Modelo enviado para análise da Meta');
    onCreated();
  }
  return (
    <Card icon="plus" title="Novo modelo de mensagem" subtitle="A Meta analisa cada modelo antes de liberar o envio (costuma levar de minutos a 1 dia).">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
        <Input label="Nome interno (minúsculas, números e _)" value={f.name} onChange={set('name')} placeholder="recuperar_carrinho" />
        <Select label="Categoria" value={f.category} onChange={set('category')} options={[{ value: 'MARKETING', label: 'Marketing (promoções, recuperação)' }, { value: 'UTILITY', label: 'Utilidade (status de pedido)' }]} />
        <Input label="Texto — use {{1}}, {{2}} para nome, produto…" value={f.body} onChange={set('body')} placeholder="Oi {{1}}, você deixou {{2}} no carrinho. Responda SAIR para não receber mais." />
        <Input label="Exemplos das variáveis, separados por |" value={f.ex} onChange={set('ex')} placeholder="Ana | Tênis Runner" />
        <Input label="Botão com link (opcional, https)" value={f.url} onChange={set('url')} placeholder="https://sualoja.com/carrinho/{{1}}" />
        {err && <Banner tone="danger">{err}</Banner>}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" disabled={busy || !f.name || !f.body} onClick={create}>{busy ? 'Enviando…' : 'Enviar para análise'}</Button>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        </div>
      </div>
    </Card>
  );
}

export function WhatsappMetaTab({ empresaId }) {
  const store = useKobly();
  const acc = useAsync(() => KoblyApi.whatsappAccount('status', {}, empresaId), [empresaId]);
  const tpls = useAsync(() => KoblyApi.listWhatsappTemplates(), [empresaId]);
  const [busy, setBusy] = useState('');
  const [creating, setCreating] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testTpl, setTestTpl] = useState('');
  const [testVars, setTestVars] = useState('');
  const [result, setResult] = useState(null);

  if (acc.status === 'loading') return <Banner tone="info" title="Verificando conexão…"><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Spinner size={13} /> Consultando o WhatsApp da empresa.</div></Banner>;
  const d = acc.data;
  if (acc.status === 'error' || (d && d.error)) return <Banner tone="danger">{(d && d.error) || acc.error}</Banner>;
  if (!d.account) return <ConnectForm empresaId={empresaId} onDone={() => { acc.reload(); tpls.reload(); }} />;

  const a = d.account;
  const [qTone, qLabel] = QUALITY[a.quality_rating] || QUALITY.UNKNOWN;
  const list = tpls.data || [];
  const approved = list.filter((t) => t.status === 'APPROVED');

  async function run(key, fn, okMsg) {
    setBusy(key); const r = await fn(); setBusy('');
    if (r.error) { store.notify('danger', r.error); return r; }
    if (okMsg) store.notify('success', okMsg(r));
    return r;
  }
  async function refresh() { await run('refresh', () => KoblyApi.whatsappAccount('status', { refresh: true }, empresaId)); acc.reload(); }
  async function sync() { const r = await run('sync', () => KoblyApi.whatsappAccount('sync_templates', {}, empresaId), (x) => `${x.synced} modelo(s) sincronizado(s)`); if (!r.error) tpls.reload(); }
  async function disconnect() {
    if (!window.confirm('Desconectar o WhatsApp desta empresa? As campanhas com WhatsApp param de enviar até conectar de novo.')) return;
    const r = await run('desconectar', () => KoblyApi.whatsappAccount('disconnect', {}, empresaId), () => 'WhatsApp desconectado');
    if (!r.error) { acc.reload(); tpls.reload(); }
  }
  async function sendTest() {
    setResult(null);
    const variables = testVars.split('|').map((x) => x.trim());
    const r = await run('test', () => KoblyApi.whatsappAccount('send_test', { to: testPhone, template_id: testTpl, variables }, empresaId));
    setResult(r.error ? { ok: false, msg: r.error } : { ok: true, msg: 'Mensagem enviada — confira o WhatsApp.' });
  }
  const sel = list.find((t) => t.id === testTpl);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Card icon="message-circle" title="WhatsApp da empresa" subtitle="Envios pela API oficial da Meta, a partir do número conectado."
        action={<div style={{ display: 'flex', gap: 8 }}><Button size="sm" variant="ghost" iconLeft="refresh-cw" disabled={busy === 'refresh'} onClick={refresh}>Atualizar</Button><Button size="sm" variant="ghost" iconLeft="unplug" disabled={busy === 'desconectar'} onClick={disconnect}>Desconectar</Button></div>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {a.status === 'connected'
            ? <Banner tone="success" title={`Conectado · ${a.display_phone || ''}`}>{a.verified_name || 'Número verificado'}</Banner>
            : <Banner tone="danger" title="Problema na conexão">{a.last_error || 'Conecte de novo com um token válido.'}</Banner>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Badge tone={qTone}>{qLabel}</Badge>
            {a.messaging_limit && <Badge tone="neutral">Limite: {a.messaging_limit.replace('TIER_', '').replace('K', ' mil/dia')}</Badge>}
          </div>
          <Banner tone="info" title="Avisos de entrega (opcional)">
            Para ver “entregue/lido” e receber pedidos de descadastro (SAIR), cadastre este endereço no painel da Meta (WhatsApp → Configuração → Webhook) e assine “messages”.
          </Banner>
          <CopyRow label="URL de retorno (callback)" value={a.webhook_url} />
          <CopyRow label="Token de verificação" value={a.verify_token} />
          {!a.has_app_secret && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}><Icon name="info" size={14} /> Sem o segredo do app, os avisos de entrega não podem ser validados e são recusados. Conecte de novo informando o segredo.</div>}
        </div>
      </Card>

      <Card icon="file-text" title="Modelos de mensagem" subtitle="A Meta só permite iniciar conversa com modelos aprovados."
        action={<div style={{ display: 'flex', gap: 8 }}><Button size="sm" variant="secondary" iconLeft="refresh-cw" disabled={busy === 'sync'} onClick={sync}>{busy === 'sync' ? 'Sincronizando…' : 'Sincronizar com a Meta'}</Button><Button size="sm" variant="primary" iconLeft="plus" onClick={() => setCreating(true)}>Novo modelo</Button></div>}>
        {list.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Nenhum modelo ainda. Crie um ou sincronize os que já existem na sua conta.</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {list.map((t) => (
              <div key={t.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between', borderTop: '1px solid var(--border-default)', paddingTop: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{t.name} <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>· {t.language} · {t.category === 'MARKETING' ? 'Marketing' : t.category === 'UTILITY' ? 'Utilidade' : t.category}</span></div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t.body_text}</div>
                  {t.rejected_reason && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--status-danger-fg)' }}>Motivo: {t.rejected_reason}</div>}
                </div>
                <Badge tone={TPL_TONE[t.status] || 'neutral'}>{TPL_LABEL[t.status] || t.status}</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>
      {creating && <NewTemplate empresaId={empresaId} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); tpls.reload(); }} />}

      <Card icon="send" title="Enviar teste" subtitle="Dispara um modelo aprovado para o seu número.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
          <Select label="Modelo aprovado" value={testTpl} onChange={(e) => setTestTpl(e.target.value)} options={[{ value: '', label: approved.length ? 'Escolha um modelo' : 'Nenhum modelo aprovado ainda' }, ...approved.map((t) => ({ value: t.id, label: t.name }))]} />
          {sel && sel.variable_count > 0 && <Input label={`Valores das ${sel.variable_count} variáveis, separados por |`} value={testVars} onChange={(e) => setTestVars(e.target.value)} placeholder="Ana | Tênis Runner" />}
          <PhoneField label="Telefone de teste" value={testPhone} onChange={setTestPhone} />
          <div><Button variant="primary" iconLeft="send" disabled={!testTpl || testPhone.replace(/\D/g, '').length < 10 || busy === 'test'} onClick={sendTest}>{busy === 'test' ? 'Enviando…' : 'Enviar teste'}</Button></div>
          {result && <Banner tone={result.ok ? 'success' : 'danger'}>{result.msg}</Banner>}
        </div>
      </Card>
    </div>
  );
}
