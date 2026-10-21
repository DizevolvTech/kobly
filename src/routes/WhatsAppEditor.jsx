import React, { useEffect, useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { KoblyAI } from '@/api/ai.js';
import { Button, Icon, IconButton, Input, Select, Spinner } from '@/ds';
import { useBreakpoint } from '@/lib/responsive.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Editor de mensagem de WhatsApp + botões interativos (CTA URL/CALL/REPLY).
// Com a API oficial da Meta o envio usa um MODELO aprovado (botões e texto vêm do modelo).

const OBJETIVO_HINTS = {
  'Abandono de carrinho': 'Recupere o cliente que abandonou o carrinho - ofereca o link de volta ao checkout.',
  'Pix Gerado': 'Lembre o cliente que o Pix foi gerado e esta aguardando pagamento.',
  'Boleto Gerado': 'Lembre o cliente que o boleto foi gerado e o prazo de vencimento.',
  'Compra Aprovada': 'Confirme a compra e entregue o acesso a area de membros / produto.',
  'Compra Recusada': 'Avise que o pagamento foi recusado e convide a tentar novamente.',
  'Compra Reembolsada': 'Confirme o reembolso processado.',
  'Compra cancelada': 'Confirme o cancelamento do pedido.',
  'Chargeback': 'Informe sobre o chargeback registrado.',
  'Cancelamento de Assinatura': 'Tente reter o cliente que cancelou a assinatura.',
  'Deposito Solicitado': 'Confirme a solicitacao de deposito bancario.',
};

const BTN_TYPES = [
  { value: 'URL', label: 'Link (CTA)' },
  { value: 'CALL', label: 'Ligar' },
  { value: 'REPLY', label: 'Resposta rápida' },
];

const VAR_FIELDS = [
  { value: 'nome', label: 'Nome do cliente' }, { value: 'produto', label: 'Produto' }, { value: 'valor', label: 'Valor da compra' },
  { value: 'cta_link', label: 'Link de recuperação' }, { value: 'loja', label: 'Nome da loja' },
];

function emptyButton() {
  return { id: String(Date.now()), type: 'URL', label: 'Concluir compra', url: '{{cta_link}}', phone: '' };
}

function KoblyWhatsAppEditor({ message, objetivo, onClose, onSave }) {
  const store = useKobly();
  const [titulo, setTitulo] = useState(message ? message.titulo : 'Nova mensagem');
  const [texto, setTexto] = useState(message ? (message.corpoTexto || '') : '');
  const [botoes, setBotoes] = useState(() => {
    const b = message && Array.isArray(message.botoes) ? message.botoes : [];
    return b.map((x, i) => ({
      id: String(x.id || i + 1),
      type: (x.type || 'URL').toUpperCase(),
      label: x.label || '',
      url: x.url || '{{cta_link}}',
      phone: x.phone || '',
    }));
  });
  // Modelo aprovado da Meta: a API oficial só inicia conversa com modelos aprovados.
  const [templates, setTemplates] = useState(null);
  const [templateId, setTemplateId] = useState(message?.templateId || '');
  const [templateVars, setTemplateVars] = useState(Array.isArray(message?.templateVars) ? message.templateVars : []);
  useEffect(() => { let on = true; KoblyApi.listWhatsappTemplates().then((t) => on && setTemplates(t)).catch(() => on && setTemplates([])); return () => { on = false; }; }, []);
  const approved = (templates || []).filter((t) => t.status === 'APPROVED');
  const chosen = approved.find((t) => t.id === templateId) || null;
  const nVars = chosen ? chosen.variable_count || 0 : 0;
  const [aiBusy, setAiBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [brief, setBrief] = useState('');
  const stacked = useBreakpoint().isNarrow;

  const objetivoLabel = objetivo || 'recuperacao de vendas';
  const hint = OBJETIVO_HINTS[objetivo] || 'Escreva uma mensagem de WhatsApp para o seu cliente.';

  async function generate() {
    setAiBusy(true);
    try {
      const out = await KoblyAI.generateWhatsappText({ brief: brief || hint, objetivo: objetivo || null });
      setTexto(out.texto);
      if (out.titulo) setTitulo(out.titulo);
      store.notify('success', 'Mensagem gerada pela IA (DeepSeek)');
    } catch (e) {
      store.notify('danger', 'Nao consegui gerar a mensagem agora. Tente de novo.');
    } finally { setAiBusy(false); }
  }

  function tryClose() {
    const origBtns = JSON.stringify(message && Array.isArray(message.botoes) ? message.botoes : []);
    const changed = titulo !== (message ? message.titulo : 'Nova mensagem')
      || texto !== (message ? (message.corpoTexto || '') : '')
      || JSON.stringify(botoes) !== origBtns;
    if (changed && !window.confirm('Voce tem alteracoes nao salvas nesta mensagem. Fechar e descartar?')) return;
    onClose();
  }

  function updateBtn(i, patch) {
    setBotoes((arr) => arr.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  }
  function removeBtn(i) {
    setBotoes((arr) => arr.filter((_, idx) => idx !== i));
  }
  function addBtn() {
    if (botoes.length >= 3) {
      store.notify('warning', 'Máximo de 3 botões por mensagem (limite WhatsApp/Z-API)');
      return;
    }
    setBotoes((arr) => [...arr, emptyButton()]);
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      const payload = {
        ...(message || {}),
        titulo,
        corpoTexto: chosen ? chosen.body_text : texto,
        templateId: templateId || null,
        templateVars: chosen ? Array.from({ length: nVars }, (_, i) => templateVars[i] || (['nome', 'produto', 'valor'][i] || 'nome')) : [],
        botoes: botoes
          .filter((b) => b.label && b.label.trim())
          .map((b, i) => ({
            id: String(b.id || i + 1),
            type: b.type,
            label: b.label.trim().slice(0, 20),
            ...(b.type === 'URL' ? { url: (b.url || '{{cta_link}}').trim() } : {}),
            ...(b.type === 'CALL' ? { phone: (b.phone || '').replace(/\D/g, '') } : {}),
          })),
      };
      if (onSave) {
        const result = await onSave(payload);
        if (result && result.error) {
          store.notify('danger', result.error);
          return;
        }
        if (result === false) return;
      }
      store.notify('success', 'Mensagem salva');
      onClose();
    } catch (e) {
      store.notify('danger', e?.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  const previewText = (chosen ? chosen.body_text : (texto || '')).replace(/\{\{cta_link\}\}/gi, '[seu link aqui]');

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={tryClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }} />
      <div style={{ position: 'relative', width: 820, maxWidth: '96vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ display: 'inline-flex', width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-sm)', background: 'var(--status-success-bg)', color: 'var(--status-success-fg)' }}>
            <Icon name="message-circle" size={18} />
          </span>
          <div>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--fw-bold)', color: 'var(--text-strong)' }}>Editor de WhatsApp</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Objetivo: {objetivoLabel}</div>
          </div>
        </header>
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: stacked ? 'column' : 'row', minHeight: 0 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, padding: 20, borderRight: stacked ? 'none' : '1px solid var(--border-subtle)', borderBottom: stacked ? '1px solid var(--border-subtle)' : 'none', overflowY: 'auto' }}>
            <Input label="Titulo interno" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Ex.: Carrinho - lembrete 1" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
              <Select label="Modelo aprovado da Meta (WhatsApp oficial)" value={templateId} onChange={(e) => { setTemplateId(e.target.value); setTemplateVars([]); }}
                options={[{ value: '', label: templates === null ? 'Carregando…' : approved.length ? 'Escolha um modelo' : 'Nenhum modelo aprovado — crie em Integrações → WhatsApp' }, ...approved.map((t) => ({ value: t.id, label: t.name }))]} />
              {chosen && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-body)', whiteSpace: 'pre-wrap' }}>{chosen.body_text}</div>}
              {chosen && Array.from({ length: nVars }, (_, i) => (
                <Select key={i} label={`Variável {{${i + 1}}}`} value={templateVars[i] || ['nome', 'produto', 'valor'][i] || 'nome'}
                  onChange={(e) => setTemplateVars((arr) => { const a = [...arr]; a[i] = e.target.value; return a; })} options={VAR_FIELDS} />
              ))}
              {!templateId && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Sem modelo escolhido, este passo não envia (a Meta não permite texto livre para iniciar conversa).</div>}
            </div>
            <div style={{ opacity: chosen ? 0.5 : 1 }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-body)', marginBottom: 6 }}>Mensagem {chosen ? '(vem do modelo)' : '(rascunho)'}</div>
              <textarea value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Escreva a mensagem. Use {{cta_link}} no texto ou nos botões." rows={6} style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', color: 'var(--text-strong)', background: 'var(--surface-sunken)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)', padding: 12, outline: 'none', resize: 'vertical', lineHeight: 1.5 }} />
              <div style={{ marginTop: 6 }}>
                <code style={{ fontSize: 'var(--text-xs)', color: 'var(--accent)', cursor: 'pointer', padding: '2px 6px', background: 'var(--accent-soft)', borderRadius: 'var(--radius-xs)' }} onClick={() => setTexto((t) => `${t}{{cta_link}}`)}>inserir {'{{cta_link}}'}</code>
              </div>
            </div>

            {/* Botões interativos */}
            <div style={{ display: chosen ? 'none' : 'flex', flexDirection: 'column', gap: 10, padding: 12, background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>
                  <Icon name="mouse-pointer-click" size={15} style={{ color: 'var(--accent)' }} />
                  Botões interativos
                </div>
                <Button size="sm" variant="secondary" iconLeft="plus" onClick={addBtn} disabled={botoes.length >= 3}>Adicionar</Button>
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                CTA com link (recomendado), ligar ou resposta rápida. Use <code>{'{{cta_link}}'}</code> na URL. Máx. 3. Não misture REPLY com URL/CALL.
              </div>
              {botoes.length === 0 && (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Nenhum botão — a mensagem sai só como texto.</div>
              )}
              {botoes.map((b, i) => (
                <div key={b.id || i} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                      <Select label="Tipo" value={b.type} onChange={(e) => updateBtn(i, { type: e.target.value })} options={BTN_TYPES} />
                    </div>
                    <div style={{ flex: 1.4 }}>
                      <Input label="Texto do botão" value={b.label} onChange={(e) => updateBtn(i, { label: e.target.value })} placeholder="Ex.: Finalizar compra" />
                    </div>
                    <IconButton icon="trash-2" size="sm" aria-label="Remover botão" onClick={() => removeBtn(i)} />
                  </div>
                  {b.type === 'URL' && (
                    <Input label="URL do link" value={b.url} onChange={(e) => updateBtn(i, { url: e.target.value })} placeholder="{{cta_link}} ou https://..." hint="Pode ser {{cta_link}} — resolvido no envio" />
                  )}
                  {b.type === 'CALL' && (
                    <Input label="Telefone (com DDI)" value={b.phone} onChange={(e) => updateBtn(i, { phone: e.target.value })} placeholder="5511999999999" />
                  )}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                <Icon name="wand-2" size={14} style={{ color: 'var(--accent)' }} />
                Gerar com IA - contexto: {objetivoLabel}
              </div>
              <input value={brief} onChange={(e) => setBrief(e.target.value)} placeholder={`Briefing opcional (ex.: ${hint})`} style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', color: 'var(--text-strong)', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', outline: 'none' }} />
              <Button variant="primary" iconLeft="wand-2" fullWidth onClick={generate} disabled={aiBusy}>{aiBusy ? 'Gerando...' : 'Gerar mensagem'}</Button>
            </div>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: '#0b141a', position: 'relative' }}>
            {aiBusy && (
              <div style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, background: 'rgba(11,20,26,0.85)', color: '#e9edef' }}>
                <Spinner size={28} style={{ color: 'var(--accent)' }} />
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-medium)' }}>Gerando mensagem...</span>
              </div>
            )}
            <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 8 }}>
              <div style={{ maxWidth: '85%', background: '#202c33', color: '#e9edef', padding: '10px 12px', borderRadius: '0 8px 8px 8px', fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--font-sans)' }}>
                {previewText || <span style={{ color: '#8696a0' }}>A mensagem aparecera aqui...</span>}
                <div style={{ fontSize: 11, color: '#8696a0', textAlign: 'right', marginTop: 4 }}>agora</div>
              </div>
              {botoes.filter((b) => b.label).map((b) => (
                <div key={b.id} style={{ maxWidth: '85%', background: '#1f2c34', border: '1px solid #2a3942', color: '#53bdeb', padding: '10px 14px', borderRadius: 8, fontSize: 14, fontWeight: 600, textAlign: 'center', fontFamily: 'var(--font-sans)' }}>
                  {b.type === 'URL' && '🔗 '}{b.type === 'CALL' && '📞 '}{b.label}
                </div>
              ))}
            </div>
          </div>
        </div>
        <footer style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: '1px solid var(--border-subtle)' }}>
          <Button variant="ghost" onClick={tryClose} disabled={saving}>Cancelar</Button>
          <Button variant="primary" iconLeft="check" loading={saving} disabled={saving} onClick={handleSave}>{saving ? 'Salvando…' : 'Salvar mensagem'}</Button>
        </footer>
      </div>
    </div>
  );
}
export { KoblyWhatsAppEditor };
