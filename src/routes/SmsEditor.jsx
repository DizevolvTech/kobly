import { useEffect, useRef, useState } from 'react';
import { clearDraft, draftKey, readDraft, useDraftAutosave } from '@/lib/editorDraft.js';
import { Button, Icon, Input } from '@/ds';
import { useBreakpoint } from '@/lib/responsive.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Editor de mensagem de SMS (canal GTI SMS). Espelha o WhatsAppEditor,
// sem botões (SMS é texto puro). Suporta {{cta_link}} e {{nome}}.
// A GTI aceita SOMENTE GSM-7: acento e emoji são transliterados/removidos no envio
// (toGsm7, inlinado em send-sms/process-steps/process-bulk). Por isso a contagem
// aqui é sempre 160/153 — não existe mais o caso UCS-2 (70/67) do Twilio: o texto
// que sai nunca tem caractere fora do GSM-7.

// Mesma transliteração dos senders — o contador precisa medir o que SAI, não o que
// foi digitado, senão "Promoção 🔥" contaria caracteres que nunca chegam à operadora.
function toGsm7(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[ç]/g, 'c').replace(/[Ç]/g, 'C')
    .replace(/[\u201C\u201D\u201E]/g, '"').replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7E\n\r]/g, '');
}

// Estimativa de segmentos igual à da edge function send-sms (sempre GSM-7).
function segInfo(text) {
  const original = text || '';
  const enviado = toGsm7(original);
  const len = enviado.length;
  const alterado = enviado !== original; // tinha acento/emoji → o envio vai diferente
  const segments = len === 0 ? 0 : (len <= 160 ? 1 : Math.ceil(len / 153));
  return { len, alterado, segments, enviado };
}

function KoblySmsEditor({ message, draftScope = '', onClose, onSave }) {
  const store = useKobly();
  const dKey = draftKey('sms', message && message.id, draftScope);
  const base = { titulo: message ? message.titulo : 'Nova mensagem', texto: message ? (message.corpoTexto || '') : '' };
  const restored = useRef(readDraft(dKey)).current;
  const init = restored ? { ...base, ...restored.values } : base;
  const [titulo, setTitulo] = useState(init.titulo);
  const [texto, setTexto] = useState(init.texto);
  useDraftAutosave(dKey, { titulo, texto }, base);
  useEffect(() => { if (restored) store.notify('info', 'Recuperamos o que você estava editando e ainda não tinha salvo.'); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [saving, setSaving] = useState(false);
  const stacked = useBreakpoint().isNarrow;

  const { len, alterado, segments } = segInfo(texto);
  // Preview mostra o texto COMO SAI (já transliterado): exibir "Você" enquanto a
  // operadora entrega "Voce" seria enganoso justo na tela que existe para conferir.
  const previewText = toGsm7(texto)
    .replace(/\{\{cta_link\}\}/gi, '[seu link aqui]')
    .replace(/\{\{nome\}\}/gi, '[nome]');

  function tryClose() {
    const changed = titulo !== (message ? message.titulo : 'Nova mensagem')
      || texto !== (message ? (message.corpoTexto || '') : '');
    if (changed && !window.confirm('Você tem alterações não salvas nesta mensagem. Fechar e descartar?')) return;
    clearDraft(dKey);
    onClose();
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      const payload = { ...(message || {}), titulo, corpoTexto: texto };
      if (onSave) {
        const result = await onSave(payload);
        if (result && result.error) { store.notify('danger', result.error); return; }
        if (result === false) return;
      }
      store.notify('success', 'Mensagem salva');
      clearDraft(dKey);
      onClose();
    } catch (e) {
      store.notify('danger', e?.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={tryClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }} />
      <div style={{ position: 'relative', width: 760, maxWidth: '96vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ display: 'inline-flex', width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-sm)', background: 'var(--status-warning-bg)', color: 'var(--status-warning-fg)' }}>
            <Icon name="smartphone" size={18} />
          </span>
          <div>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--fw-bold)', color: 'var(--text-strong)' }}>Editor de SMS</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Texto puro · GTI SMS</div>
          </div>
        </header>

        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: stacked ? 'column' : 'row', minHeight: 0 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, padding: 20, borderRight: stacked ? 'none' : '1px solid var(--border-subtle)', borderBottom: stacked ? '1px solid var(--border-subtle)' : 'none', overflowY: 'auto' }}>
            <Input label="Título interno" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Ex.: SMS — lembrete de carrinho" />
            <div>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-body)', marginBottom: 6 }}>Mensagem</div>
              <textarea value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Escreva o SMS. Use {{cta_link}} e {{nome}} — resolvidos no envio." rows={6}
                style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', color: 'var(--text-strong)', background: 'var(--surface-sunken)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)', padding: 12, outline: 'none', resize: 'vertical', lineHeight: 1.5 }} />
              <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <code style={{ fontSize: 'var(--text-xs)', color: 'var(--accent)', cursor: 'pointer', padding: '2px 6px', background: 'var(--accent-soft)', borderRadius: 'var(--radius-xs)' }} onClick={() => setTexto((t) => `${t}{{cta_link}}`)}>inserir {'{{cta_link}}'}</code>
                <code style={{ fontSize: 'var(--text-xs)', color: 'var(--accent)', cursor: 'pointer', padding: '2px 6px', background: 'var(--accent-soft)', borderRadius: 'var(--radius-xs)' }} onClick={() => setTexto((t) => `${t}{{nome}}`)}>inserir {'{{nome}}'}</code>
              </div>
              <div style={{ marginTop: 8, fontSize: 'var(--text-xs)', color: segments > 1 ? 'var(--status-warning-fg)' : 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="info" size={13} />
                {len} caractere(s) · {segments} segmento(s){alterado ? ' · acentos e emojis serão removidos no envio (a operadora só aceita GSM-7)' : ''}. Cada segmento é cobrado à parte.
              </div>
            </div>
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--surface-sunken)', position: 'relative' }}>
            <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 8 }}>
              <div style={{ maxWidth: '85%', alignSelf: 'flex-start', background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', color: 'var(--text-strong)', padding: '10px 12px', borderRadius: '4px 14px 14px 14px', fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--font-sans)' }}>
                {previewText || <span style={{ color: 'var(--text-muted)' }}>A mensagem aparecerá aqui…</span>}
              </div>
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
export { KoblySmsEditor };
