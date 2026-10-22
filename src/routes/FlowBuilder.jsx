import React, { useState, useRef, useEffect } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { KoblyAI } from '@/api/ai.js';
import { KoblyMockDB } from '@/api/mockData.js';
import { Badge, Button, Card, Icon, IconButton, Input, Select } from '@/ds';
import { useAsync } from '@/lib/hooks.jsx';
import { AISuggestion, ErrorState } from '@/lib/ui.jsx';
import { KoblyEmailEditor } from '@/routes/EmailEditor.jsx';
import { KoblyWhatsAppEditor } from '@/routes/WhatsAppEditor.jsx';
import { KoblySmsEditor } from '@/routes/SmsEditor.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Construtor de fluxo (drag-drop). Paleta de cards (@TipoCardFluxo) → arrasta para
// o fluxo, reordena, edita etapa no inspetor, define tags-meta, ativa o fluxo.
// Layout com variações (tweak: builderVariant = vertical | horizontal | compact).
// KoblyFlowBuilder

const CARD_TYPES = ['Gatilho', 'Adicionar Tag', 'Remover Tag', 'Envio de e-mail', 'Envio de WhatsApp', 'Envio de SMS', 'Condição', 'Acionar Fluxo'];

// Tom/ícone do card com fallback local p/ tipos ainda não mapeados no mockData (ex.: WhatsApp/SMS).
const cardToneOf = (tipo) => KoblyMockDB.cardTone[tipo] || (tipo === 'Envio de WhatsApp' ? 'success' : tipo === 'Envio de SMS' ? 'warning' : tipo === 'Condição' ? 'info' : 'neutral');
const cardIconOf = (tipo) => KoblyMockDB.cardIcon[tipo] || (tipo === 'Envio de WhatsApp' ? 'message-circle' : tipo === 'Envio de SMS' ? 'smartphone' : tipo === 'Condição' ? 'git-branch' : 'circle');

function fmtDelay(min) {
  if (!min) return 'imediato';
  if (min < 60) return `${min} min`;
  if (min < 1440) return `${(min / 60).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`;
  return `${(min / 1440).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} dia(s)`;
}

// Condição de envio (IF/ELSE do fluxo) — avaliada pelo motor na HORA do envio,
// contra "Compra Aprovada" do lead desde o início da execução do fluxo.
const CONDICAO_OPTIONS = [
  { value: '', label: 'Sempre enviar' },
  { value: 'nao_comprou', label: 'Apenas se ainda NÃO comprou' },
  { value: 'comprou', label: 'Apenas se JÁ comprou' },
];
const condicaoBadge = (condicao) => (
  condicao === 'comprou' ? { tone: 'success', label: 'se comprou' }
  : condicao === 'nao_comprou' ? { tone: 'warning', label: 'se não comprou' }
  : null
);
function defaultConfig(tipo, opts) {
  const o = opts || { webhooks: [], emails: [] };
  switch (tipo) {
    // Webhook de origem fica no topo da campanha (seletor global) — não no card.
    case 'Gatilho': return { tipoEvento: 'Abandono de carrinho' };
    case 'Adicionar Tag':
    case 'Remover Tag': return { tags: [] };
    // E-mail é criado/editado no card (sem lista de templates pré-prontos).
    case 'Envio de e-mail': return { emailId: null };
    case 'Envio de WhatsApp': return { whatsappMessageId: (o.whatsappMessages || [])[0] ? o.whatsappMessages[0].id : null };
    case 'Envio de SMS': return { smsMessageId: (o.smsMessages || [])[0] ? o.smsMessages[0].id : null };
    case 'Condição': return { condTipo: 'comprou' }; // v1: única condição — "o lead comprou?"
    case 'Acionar Fluxo': return { fluxoAlvo: '' };
    default: return {};
  }
}
function newStep(tipo, opts, extra) {
  return { id: 'st_' + Date.now() + '_' + Math.floor(Math.random() * 999), tipo, nome: tipo, atraso: (tipo === 'Gatilho' || tipo === 'Condição') ? 0 : 30, config: defaultConfig(tipo, opts), ...(extra || {}) };
}

// ----- Paleta -----
// Arraste o card para o fluxo OU clique para adicionar ao final (fallback robusto).
function Palette({ onDragStart, onAdd }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: 'var(--ls-wide)', fontWeight: 'var(--fw-semibold)', padding: '0 2px 4px' }}>Cards do fluxo · arraste ou clique</div>
      {CARD_TYPES.map((tipo) => (
        <button key={tipo} type="button" draggable onDragStart={(e) => onDragStart(e, 'new:' + tipo)} onClick={() => onAdd(tipo)}
          title={`Adicionar "${tipo}" ao fluxo`}
          className="kbly-palette-card"
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', width: '100%', textAlign: 'start', background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', cursor: 'grab', fontFamily: 'var(--font-sans)', transition: 'border-color var(--dur-fast), transform var(--dur-fast)' }}>
          <span style={{ display: 'inline-flex', width: 30, height: 30, flex: 'none', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-sm)', background: `var(--status-${cardToneOf(tipo)}-bg)`, color: `var(--status-${cardToneOf(tipo)}-fg)` }}>
            <Icon name={cardIconOf(tipo)} size={16} />
          </span>
          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{tipo}</span>
          <Icon name="plus" size={15} style={{ color: 'var(--text-subtle)', marginInlineStart: 'auto', flex: 'none' }} />
        </button>
      ))}
    </div>
  );
}

// ----- Card de etapa no fluxo -----
function StepCard({ step, index, selected, onSelect, onDelete, onDragStart, compact, opts = {} }) {
  const tone = cardToneOf(step.tipo);
  const summary = (() => {
    const c = step.config || {};
    if (step.tipo === 'Gatilho') return c.tipoEvento;
    if (step.tipo === 'Adicionar Tag' || step.tipo === 'Remover Tag') return `${(c.tags || []).length} tag(s)`;
    if (step.tipo === 'Envio de e-mail') return ((opts.emails || []).find((e) => e.id === c.emailId) || {}).titulo || 'e-mail';
    if (step.tipo === 'Envio de WhatsApp') return ((opts.whatsappMessages || []).find((m) => m.id === c.whatsappMessageId) || {}).titulo || 'mensagem WhatsApp';
    if (step.tipo === 'Envio de SMS') return ((opts.smsMessages || []).find((m) => m.id === c.smsMessageId) || {}).titulo || 'mensagem SMS';
    if (step.tipo === 'Condição') return 'O lead comprou?';
    if (step.tipo === 'Acionar Fluxo') return ((opts.campaigns || []).find((x) => x.id === c.fluxoAlvo) || {}).nome || 'selecionar fluxo';
    return '';
  })();
  return (
    <div draggable onDragStart={(e) => onDragStart(e, step.id)} onClick={() => onSelect(step.id)}
      className="kbly-step"
      style={{
        position: 'relative', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer',
        // border-box: sem o reset global, width 100% + padding + borda estoura a coluna do ramo.
        boxSizing: 'border-box',
        padding: compact ? '10px 12px' : '14px 16px', width: compact ? '100%' : 280,
        background: 'var(--surface-card)', borderRadius: 'var(--radius-md)',
        border: `1px solid ${selected ? 'var(--border-accent)' : 'var(--border-subtle)'}`,
        boxShadow: selected ? 'var(--glow-accent-soft)' : 'var(--shadow-xs)',
        transition: 'border-color var(--dur-fast), box-shadow var(--dur-fast)',
      }}>
      <span style={{ display: 'inline-flex', width: 34, height: 34, flex: 'none', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-sm)', background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-fg)` }}>
        <Icon name={cardIconOf(step.tipo)} size={17} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* flexWrap: badges quebram pra 2ª linha em colunas estreitas (ramos) em vez de estourar o card */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', rowGap: 2 }}>
          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', whiteSpace: 'nowrap' }}>{step.tipo}</span>
          {step.tipo !== 'Gatilho' && step.atraso > 0 && <Badge tone="neutral" size="sm" style={{ flex: 'none' }}><Icon name="clock" size={12} />{fmtDelay(step.atraso)}</Badge>}
          {(() => { const b = condicaoBadge((step.config || {}).condicao); return b ? <Badge tone={b.tone} size="sm" style={{ flex: 'none' }}>{b.label}</Badge> : null; })()}
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{summary}</div>
      </div>
      {step.tipo !== 'Gatilho' && <IconButton icon="trash-2" size="sm" aria-label="Excluir etapa" onClick={(e) => { e.stopPropagation(); onDelete(step.id); }} />}
    </div>
  );
}

// ----- Ramos do card Condição (redirecionador IF/ELSE) -----
// Desenha as duas colunas SIM/NÃO abaixo do card Condição. Filhos são steps
// com parentId = id do card e ramo 'sim'/'nao'; a ordem é a do array de steps.
// v1: dentro do ramo só cards de ENVIO (e-mail/WhatsApp) — a condição é
// compilada em flow_steps.condicao no save e o motor só avalia envios.
const RAMOS = [
  { key: 'sim', label: 'SIM — já comprou', tone: 'success', icon: 'check' },
  { key: 'nao', label: 'NÃO — ainda não comprou', tone: 'warning', icon: 'x' },
];
function BranchSplit({ cond, steps, selId, onSelect, onDelete, onAddChild, opts, compact }) {
  return (
    // minmax(0,1fr): sem isso o nowrap dos badges dos cards impede a coluna de
    // encolher (min-content) e o grid estoura pra fora do canvas.
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12, width: '100%', marginTop: 4 }}>
      {RAMOS.map((r) => {
        const children = steps.filter((s) => s.parentId === cond.id && s.ramo === r.key);
        return (
          <div key={r.key} style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--surface-card)', border: `1px dashed var(--status-${r.tone}-fg)`, borderRadius: 'var(--radius-md)', padding: 10, minHeight: 90 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', fontWeight: 'var(--fw-semibold)', color: `var(--status-${r.tone}-fg)`, textTransform: 'uppercase', letterSpacing: 'var(--ls-wide)' }}>
              <Icon name={r.icon} size={13} /> {r.label}
            </div>
            {children.map((s, i) => (
              <StepCard key={s.id} step={s} index={i} selected={selId === s.id} onSelect={onSelect} onDelete={onDelete} onDragStart={() => {}} compact opts={opts} />
            ))}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Button size="sm" variant="ghost" iconLeft="mail" onClick={() => onAddChild(cond.id, r.key, 'Envio de e-mail')}>+ E-mail</Button>
              <Button size="sm" variant="ghost" iconLeft="message-circle" onClick={() => onAddChild(cond.id, r.key, 'Envio de WhatsApp')}>+ WhatsApp</Button>
              <Button size="sm" variant="ghost" iconLeft="smartphone" onClick={() => onAddChild(cond.id, r.key, 'Envio de SMS')}>+ SMS</Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ----- Slot de inserção (drop zone) + conector do trilho -----
// Continua sendo o alvo de drag (barra accent no hover), mas em repouso desenha
// o CONECTOR do fluxo (linha vertical + seta) — continuidade visual (Gestalt):
// o olho lê a sequência Gatilho → envio → envio em vez de cards soltos.
function DropSlot({ index, over, onOver, onDrop, horizontal, arrow }) {
  const showArrow = arrow && !over && !horizontal;
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); onOver(index); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop(index); }}
      style={horizontal
        ? { width: over ? 30 : 14, alignSelf: 'stretch', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'width var(--dur-fast)' }
        : { height: over ? 30 : (showArrow ? 28 : 14), display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'height var(--dur-fast)' }}>
      {showArrow ? (
        <div aria-hidden style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ width: 2, height: 16, background: 'var(--border-default)' }} />
          <Icon name="chevron-down" size={14} style={{ color: 'var(--text-subtle)', marginTop: -6 }} />
        </div>
      ) : (
        <div style={{
          background: over ? 'var(--accent)' : 'transparent',
          borderRadius: 'var(--radius-pill)',
          ...(horizontal ? { width: over ? 4 : 2, height: '60%' } : { height: over ? 4 : 2, width: over ? '100%' : 40 }),
          transition: 'all var(--dur-fast)',
        }} />
      )}
    </div>
  );
}

// ----- Conector em forquilha: card Condição → ramos SIM/NÃO -----
// Tronco central + barra horizontal + duas descidas com seta na cor de cada
// ramo — mostra que o fluxo SE DIVIDE ali (era o elo visual que faltava).
function ForkConnector() {
  return (
    <div aria-hidden style={{ width: '100%', height: 30, position: 'relative', flex: 'none' }}>
      <div style={{ position: 'absolute', left: '50%', top: 0, width: 2, height: 10, background: 'var(--border-default)', transform: 'translateX(-50%)' }} />
      <div style={{ position: 'absolute', left: '25%', right: '25%', top: 10, height: 2, background: 'var(--border-default)' }} />
      {[{ left: '25%', tone: 'success' }, { left: '75%', tone: 'warning' }].map((r) => (
        <div key={r.left} style={{ position: 'absolute', left: r.left, top: 10, transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ width: 2, height: 12, background: 'var(--border-default)' }} />
          <Icon name="chevron-down" size={13} style={{ color: `var(--status-${r.tone}-fg)`, marginTop: -6 }} />
        </div>
      ))}
    </div>
  );
}

// ----- Inspetor da etapa -----
function Inspector({
  step, onChange, onEditEmail, onEditWhatsApp, onEditSms, onCopyEmailFromModel, opts = {}, brand = null,
}) {
  const DB = KoblyMockDB;
  const store = useKobly();
  const [copyFrom, setCopyFrom] = useState('');
  const [copying, setCopying] = useState(false);
  if (!step) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 10, height: '100%', color: 'var(--text-muted)', padding: 24 }}>
        <span style={{ display: 'inline-flex', width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-lg)', background: 'var(--surface-sunken)' }}><Icon name="mouse-pointer-2" size={22} /></span>
        <div style={{ fontSize: 'var(--text-sm)' }}>Selecione uma etapa para editar, ou arraste um card da paleta para o fluxo.</div>
      </div>
    );
  }
  const c = step.config || {};
  const set = (patch) => onChange({ ...step, ...patch });
  const setCfg = (patch) => onChange({ ...step, config: { ...c, ...patch } });
  function toggleTag(id) {
    const has = (c.tags || []).includes(id);
    setCfg({ tags: has ? c.tags.filter((t) => t !== id) : [...(c.tags || []), id] });
  }
  const linkedEmail = (opts.emails || []).find((em) => em.id === c.emailId);
  // Modelos da biblioteca = e-mails da org que NÃO são o da etapa atual (podem reutilizar).
  const libraryEmails = (opts.emails || []).filter((em) => em.id !== c.emailId);

  async function handleCopyFromModel() {
    if (!copyFrom || !onCopyEmailFromModel) return;
    setCopying(true);
    try {
      const r = await onCopyEmailFromModel(copyFrom, step.id);
      if (r && r.error) store.notify('danger', r.error);
      else {
        store.notify('success', 'Modelo copiado para esta etapa (cópia independente)');
        setCopyFrom('');
      }
    } finally {
      setCopying(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ display: 'inline-flex', width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-sm)', background: `var(--status-${cardToneOf(step.tipo)}-bg)`, color: `var(--status-${cardToneOf(step.tipo)}-fg)` }}><Icon name={cardIconOf(step.tipo)} size={16} /></span>
        <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--fw-bold)', color: 'var(--text-strong)' }}>{step.tipo}</span>
      </div>
      <Input label="Nome da etapa" value={step.nome} onChange={(e) => set({ nome: e.target.value })} />

      {step.tipo === 'Gatilho' && (
        <React.Fragment>
          <Select label="Tipo de evento" value={c.tipoEvento || ''} onChange={(e) => setCfg({ tipoEvento: e.target.value })} options={DB.optionSets.TipoEvento} />
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            O webhook de origem é definido no topo da campanha (seletor global), não por etapa.
          </div>
        </React.Fragment>
      )}
      {(step.tipo === 'Adicionar Tag' || step.tipo === 'Remover Tag') && (
        <div>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-body)', marginBottom: 8 }}>Tags</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(opts.tags || []).map((t) => {
              const on = (c.tags || []).includes(t.id);
              return (
                <button key={t.id} onClick={() => toggleTag(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: `1px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'}`, background: on ? 'var(--accent-soft)' : 'var(--surface-sunken)', cursor: 'pointer', textAlign: 'start', fontFamily: 'var(--font-sans)' }}>
                  <span style={{ display: 'inline-flex', width: 18, height: 18, alignItems: 'center', justifyContent: 'center', borderRadius: 5, border: on ? 'none' : '1.5px solid var(--border-default)', background: on ? 'var(--accent)' : 'transparent', color: 'var(--text-on-accent)' }}>{on && <Icon name="check" size={12} />}</span>
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-strong)' }}>{t.nome}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {step.tipo === 'Envio de e-mail' && (
        <React.Fragment>
          {/* Caminho principal: criar/editar conteúdo nesta etapa (marca da campanha no editor). */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-body)' }}>Conteúdo desta etapa</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.45 }}>
              Aqui fica o <b>assunto e o HTML</b>. Identidade (logo/cor) vem da marca da campanha
              {brand?.nome ? ` (${brand.nome})` : ''}.
            </div>
            {c.emailId && linkedEmail ? (
              <div style={{ padding: '10px 12px', background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{linkedEmail.titulo || 'E-mail da etapa'}</div>
                {linkedEmail.assunto && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>{linkedEmail.assunto}</div>}
              </div>
            ) : (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--status-warning-fg)', background: 'var(--status-warning-bg)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
                Nenhum e-mail nesta etapa — crie o conteúdo para o fluxo enviar.
              </div>
            )}
            <Button variant="primary" size="sm" iconLeft={c.emailId ? 'pencil' : 'plus'} onClick={() => onEditEmail(c.emailId)}>
              {c.emailId ? 'Editar e-mail' : 'Criar e-mail desta etapa'}
            </Button>

            {libraryEmails.length > 0 && (
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                  Opcional: copiar de um modelo da biblioteca (gera <b>cópia independente</b> nesta etapa).
                </div>
                <Select
                  value={copyFrom}
                  onChange={(e) => setCopyFrom(e.target.value)}
                  options={[{ value: '', label: 'Escolher modelo…' }, ...libraryEmails.map((m) => ({ value: m.id, label: m.titulo || m.assunto || 'Modelo' }))]}
                />
                <Button variant="secondary" size="sm" iconLeft="copy" disabled={!copyFrom || copying} loading={copying} onClick={handleCopyFromModel}>
                  {copying ? 'Copiando…' : 'Copiar modelo para esta etapa'}
                </Button>
              </div>
            )}
          </div>
        </React.Fragment>
      )}
      {step.tipo === 'Envio de WhatsApp' && (
        <React.Fragment>
          <Select label="Mensagem WhatsApp" value={c.whatsappMessageId || ''} onChange={(e) => setCfg({ whatsappMessageId: e.target.value })} options={[{ value: '', label: 'Selecionar…' }, ...(opts.whatsappMessages || []).map((m) => ({ value: m.id, label: m.titulo }))]} />
          <Button variant="secondary" size="sm" iconLeft="pencil" onClick={() => onEditWhatsApp(c.whatsappMessageId)}>Editar mensagem</Button>
        </React.Fragment>
      )}
      {step.tipo === 'Envio de SMS' && (
        <React.Fragment>
          <Select label="Mensagem SMS" value={c.smsMessageId || ''} onChange={(e) => setCfg({ smsMessageId: e.target.value })} options={[{ value: '', label: 'Selecionar…' }, ...(opts.smsMessages || []).map((m) => ({ value: m.id, label: m.titulo }))]} />
          <Button variant="secondary" size="sm" iconLeft="pencil" onClick={() => onEditSms(c.smsMessageId)}>Editar mensagem</Button>
        </React.Fragment>
      )}
      {step.tipo === 'Acionar Fluxo' && (
        <Select label="Fluxo a acionar" value={c.fluxoAlvo || ''} onChange={(e) => setCfg({ fluxoAlvo: e.target.value })} options={[{ value: '', label: 'Selecionar…' }, ...(opts.campaigns || []).map((x) => ({ value: x.id, label: x.nome }))]} />
      )}
      {step.tipo === 'Condição' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Select label="Condição" value={c.condTipo || 'comprou'} onChange={(e) => setCfg({ condTipo: e.target.value })} options={[{ value: 'comprou', label: 'O lead comprou?' }]} />
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Divide o fluxo em dois ramos. Cada envio dos ramos é avaliado na SUA hora de envio: quem pagar no meio da cadência migra do ramo NÃO para o ramo SIM automaticamente.
          </div>
        </div>
      )}
      {(step.tipo === 'Envio de e-mail' || step.tipo === 'Envio de WhatsApp' || step.tipo === 'Envio de SMS') && (
        step.parentId ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-body)' }}>Condição de envio</div>
            <Badge tone={step.ramo === 'sim' ? 'success' : 'warning'} style={{ alignSelf: 'flex-start' }}>
              Herdada do ramo: {step.ramo === 'sim' ? 'SIM — só se JÁ comprou' : 'NÃO — só se ainda não comprou'}
            </Badge>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Definida pelo card Condição acima — arraste o card pra raiz do fluxo se quiser uma condição própria.</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Select
              label="Condição de envio"
              value={c.condicao || ''}
              onChange={(e) => setCfg({ condicao: e.target.value || null })}
              options={CONDICAO_OPTIONS}
            />
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              Avaliada na hora do envio: quem pagou no meio da cadência para de receber recuperação ("NÃO comprou") e pode receber o agradecimento ("JÁ comprou") no mesmo fluxo.
            </div>
          </div>
        )
      )}

      {step.tipo !== 'Gatilho' && step.tipo !== 'Condição' && (
        <Input label="Atraso (minutos)" type="number" value={step.atraso} onChange={(e) => set({ atraso: Math.max(0, parseInt(e.target.value || '0', 10)) })} hint={`Aguarda ${fmtDelay(step.atraso)} após a etapa anterior.`} />
      )}
    </div>
  );
}

function KoblyFlowBuilder({ campaign, onBack, variant = 'vertical' }) {
  const store = useKobly();
  const DB = KoblyMockDB;
  const optsA = useAsync(() => KoblyApi.getFlowOptions(), [store.role]);
  const opts = optsA.data || { webhooks: [], emails: [], whatsappMessages: [], smsMessages: [], tags: [], campaigns: [] };
  // UX-1: rascunho do fluxo em localStorage (restaurado ao reabrir a campanha).
  const draftKey = `kobly:flowdraft:${campaign.id}`;
  const [restoredDraft] = useState(() => {
    try { const raw = localStorage.getItem(draftKey); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  });
  const [steps, setSteps] = useState(() => (restoredDraft && Array.isArray(restoredDraft.steps) ? restoredDraft.steps : (campaign.fluxo || [])));
  const [tagsMeta, setTagsMeta] = useState(() => (restoredDraft && Array.isArray(restoredDraft.tagsMeta) ? restoredDraft.tagsMeta : (campaign.tagsMeta || [])));
  const [selId, setSelId] = useState(steps[0] ? steps[0].id : null);
  const [over, setOver] = useState(-1);
  const [status, setStatus] = useState(campaign.status);
  const [emailModal, setEmailModal] = useState(null);
  // TPL-1: modal do editor de WhatsApp (espelha o emailModal).
  const [whatsappModal, setWhatsappModal] = useState(null);
  // SMS: modal do editor de SMS (espelha o whatsappModal).
  const [smsModal, setSmsModal] = useState(null);
  // Reabrir o editor que estava aberto (aba trocada, página recarregada). O texto digitado volta do rascunho do próprio editor.
  const openKey = `kobly:openeditor:${campaign.id}`;
  const restoredOpen = useRef(false);
  useEffect(() => {
    if (restoredOpen.current || optsA.status === 'loading' || !optsA.data) return;
    restoredOpen.current = true;
    let o = null; try { o = JSON.parse(sessionStorage.getItem(openKey) || 'null'); } catch { /* ignora */ }
    if (!o) return;
    if (o.selId) setSelId(o.selId);
    const pick = (list, blank) => (o.id ? (list || []).find((m) => m.id === o.id) : null) || blank;
    if (o.kind === 'email') setEmailModal(pick(optsA.data.emails, { titulo: '', assunto: '', remetente: '', corpoHtml: '' }));
    if (o.kind === 'whatsapp') setWhatsappModal(pick(optsA.data.whatsappMessages, { titulo: 'Nova mensagem', corpoTexto: '' }));
    if (o.kind === 'sms') setSmsModal(pick(optsA.data.smsMessages, { titulo: 'Nova mensagem', corpoTexto: '' }));
  }, [optsA.status, optsA.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!restoredOpen.current) return;
    const cur = emailModal ? ['email', emailModal] : whatsappModal ? ['whatsapp', whatsappModal] : smsModal ? ['sms', smsModal] : null;
    try { cur ? sessionStorage.setItem(openKey, JSON.stringify({ kind: cur[0], id: cur[1].id || null, selId })) : sessionStorage.removeItem(openKey); } catch { /* sem armazenamento */ }
  }, [emailModal, whatsappModal, smsModal, selId]); // eslint-disable-line react-hooks/exhaustive-deps
  // TPL-2: objetivo = tipo_evento do Gatilho da campanha (passado à IA do WhatsApp).
  const objetivoCampanha = (steps.find((s) => s.tipo === 'Gatilho')?.config || {}).tipoEvento || null;
  const [dirty, setDirty] = useState(!!restoredDraft);
  // UX-2: estado de saving no botão — feedback imediato para o usuário
  // (antes o clique não dava sinal e o layout shift de dirty→false parecia scroll).
  const [saving, setSaving] = useState(false);
  const [nome, setNome] = useState(campaign.nome);
  const [editingName, setEditingName] = useState(false);
  const [nomeDraft, setNomeDraft] = useState(campaign.nome);
  // WEB-1: seletor de webhook nomeado vinculado à campanha.
  const tokensA = useAsync(() => KoblyApi.getPostbackTokens(), [campaign.empresaId]);
  const tokens = (tokensA.data || []).filter((t) => t.ativo);
  const [webhookId, setWebhookId] = useState(campaign.postbackTokenId || '');
  async function saveWebhook(id) {
    const ok = await KoblyApi.setCampaignWebhook(campaign.id, id || null);
    setWebhookId(id || '');
    store.notify(ok ? 'success' : 'danger', ok ? (id ? 'Webhook vinculado à campanha' : 'Campanha aceita qualquer webhook') : 'Não foi possível atualizar');
  }
  // MARCA-1: seletor de marca/produto vinculado à campanha.
  const brandsA = useAsync(() => KoblyApi.listBrands(campaign.empresaId), [campaign.empresaId]);
  const brands = brandsA.data || [];
  const [brandId, setBrandId] = useState(campaign.brandId || '');
  // Marca efetiva: a vinculada, senão a 1ª da org (padrão do worker).
  const activeBrand = brands.find((b) => b.id === brandId) || brands[0] || null;
  async function saveBrand(id) {
    const ok = await KoblyApi.setCampaignBrand(campaign.id, id || null);
    setBrandId(id || '');
    store.notify(ok ? 'success' : 'danger', ok ? (id ? 'Marca vinculada à campanha' : 'Campanha usa a marca padrão') : 'Não foi possível atualizar');
  }
  const dragRef = useRef(null);
  const horizontal = variant === 'horizontal';
  const compact = variant === 'compact';

  if (optsA.status === 'error') return <ErrorState message={optsA.error} onRetry={optsA.reload} />;

  const selStep = steps.find((s) => s.id === selId) || null;
  const markDirty = () => setDirty(true);

  // UX-1 — Persistência da edição do fluxo:
  // (a) rascunho salvo no localStorage a cada alteração (debounce) e restaurado ao
  //     reabrir a campanha — sair da tela (copiar um link, navegar pelo menu) não
  //     perde mais o trabalho;
  // (b) "sair sem salvar?" no botão Voltar; a navegação pelo rail também confirma
  //     (guard no store.navigate, que lê store.editing registrado abaixo);
  // (c) beforeunload cobre fechar aba / recarregar durante a edição.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      try { localStorage.setItem(draftKey, JSON.stringify({ steps, tagsMeta, savedAt: Date.now() })); } catch (_) { /* quota/privado */ }
    }, 500);
    return () => clearTimeout(t);
  }, [dirty, steps, tagsMeta, draftKey]);

  // Registra no store se há edição ativa (a navegação consulta p/ confirmar).
  useEffect(() => {
    store.setEditing({ campaignId: campaign.id, dirty });
    return () => store.clearEditing();
  }, [campaign.id, dirty, store]);

  // Aviso nativo ao sair/fechar a aba com alterações não salvas.
  useEffect(() => {
    if (!dirty) return;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // Avisa uma vez quando um rascunho foi recuperado (só na montagem).
  useEffect(() => { if (restoredDraft) store.notify('info', 'Rascunho não salvo recuperado.'); /* monta uma vez */ }, []);

  function handleBack() {
    if (dirty && !window.confirm('Você tem alterações não salvas. O rascunho fica salvo e será recuperado quando voltar. Sair da campanha?')) return;
    onBack();
  }

  function onDragStart(e, payload) {
    dragRef.current = payload;
    e.dataTransfer.effectAllowed = 'move';
    // alguns navegadores (Firefox) exigem setData p/ o drag iniciar
    try { e.dataTransfer.setData('text/plain', payload); } catch (_) { /* noop */ }
  }
  // Raiz do fluxo = steps sem parentId (filhos vivem nos ramos do card Condição).
  const rootSteps = steps.filter((s) => !s.parentId);
  // Índice de RAIZ → índice no array FLAT (os DropSlots operam sobre a raiz).
  const rootToFlat = (rootIndex) => {
    if (rootIndex >= rootSteps.length) return steps.length;
    return steps.findIndex((s) => s.id === rootSteps[rootIndex].id);
  };

  // Clique na paleta adiciona o card ao FINAL do fluxo (fallback sem DnD).
  function addStep(tipo) {
    const s = newStep(tipo, opts);
    setSteps((arr) => [...arr, s]);
    setSelId(s.id); markDirty();
  }
  // Adiciona um card de ENVIO dentro de um ramo do card Condição.
  function addChild(condId, ramo, tipo) {
    const s = newStep(tipo, opts, { parentId: condId, ramo });
    setSteps((arr) => [...arr, s]);
    setSelId(s.id); markDirty();
  }
  function onDrop(targetRootIndex) {
    const payload = dragRef.current; dragRef.current = null; setOver(-1);
    if (!payload) return;
    const targetIndex = rootToFlat(targetRootIndex);
    if (payload.startsWith('new:')) {
      const tipo = payload.slice(4);
      const s = newStep(tipo, opts);
      setSteps((arr) => { const next = arr.slice(); next.splice(targetIndex, 0, s); return next; });
      setSelId(s.id); markDirty();
    } else {
      const from = steps.findIndex((s) => s.id === payload);
      if (from === -1) return;
      setSteps((arr) => {
        const next = arr.slice();
        const [moved] = next.splice(from, 1);
        const insertAt = from < targetIndex ? targetIndex - 1 : targetIndex;
        // Arrastar pra raiz TIRA o card do ramo (vira etapa raiz na posição do drop).
        next.splice(insertAt, 0, { ...moved, parentId: null, ramo: null });
        return next;
      });
      markDirty();
    }
  }
  function updateStep(updated) { setSteps((arr) => arr.map((s) => (s.id === updated.id ? updated : s))); markDirty(); }
  // Excluir um card Condição leva os filhos dos ramos junto (mesmo cascade do banco).
  function deleteStep(id) {
    setSteps((arr) => arr.filter((s) => s.id !== id && s.parentId !== id));
    if (selId === id) setSelId(null); markDirty();
  }
  function toggleMeta(id) { setTagsMeta((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id])); markDirty(); }

  async function save() {
    // Validação pré-save: cards de envio precisam ter mensagem/e-mail selecionado.
    const incompleto = steps.find((s) => {
      const c = s.config || {};
      if (s.tipo === 'Envio de WhatsApp' && !c.whatsappMessageId) return true;
      if (s.tipo === 'Envio de SMS' && !c.smsMessageId) return true;
      if (s.tipo === 'Envio de e-mail' && !c.emailId) return true;
      return false;
    });
    if (incompleto) {
      const oque = incompleto.tipo === 'Envio de WhatsApp' ? 'uma mensagem de WhatsApp'
        : incompleto.tipo === 'Envio de SMS' ? 'uma mensagem de SMS' : 'um e-mail';
      store.notify('warning', `O card "${incompleto.nome || incompleto.tipo}" está incompleto: selecione ${oque} antes de salvar.`);
      return;
    }
    // UX-2: feedback visual imediato (loading no botão) para o usuário saber que está salvando.
    setSaving(true);
    const res = await KoblyApi.saveFlow(campaign.id, steps, tagsMeta);
    setSaving(false);
    if (!res || !res.ok) {
      store.notify('danger', 'Não foi possível salvar o fluxo. Tente novamente.');
      return; // mantém o estado "não salvo" (dirty)
    }
    // Reconcilia ids temporários (st_...) → ids do banco. Sem isto, um 2º save seguido
    // (sem sair da tela) recriaria os steps novos e apagaria os antigos — junto com a fila.
    const idMap = res.idMap || {};
    if (Object.keys(idMap).length) {
      setSteps((prev) => prev.map((s) => ({
        ...s,
        id: idMap[s.id] || s.id,
        parentId: s.parentId ? (idMap[s.parentId] || s.parentId) : s.parentId,
      })));
      setSelId((cur) => (cur && idMap[cur]) || cur);
    }
    try { localStorage.removeItem(draftKey); } catch (_) { /* noop */ }
    setDirty(false);
    store.notify('success', 'Fluxo salvo');
  }
  async function toggleActive() {
    const next = status === 'Ativa' ? 'Pausada' : 'Ativa';
    await KoblyApi.setCampaignStatus(campaign.id, next);
    setStatus(next);
    store.notify(next === 'Ativa' ? 'success' : 'warning', `Campanha ${next === 'Ativa' ? 'ativada' : 'pausada'}`);
  }
  async function saveName() {
    const clean = (nomeDraft || '').trim();
    setEditingName(false);
    if (!clean || clean === nome) { setNomeDraft(nome); return; }
    setNome(clean);
    campaign.nome = clean; // mantém o objeto em memória coerente (usado pela IA/breadcrumb)
    const ok = await KoblyApi.renameCampaign(campaign.id, clean);
    store.notify(ok ? 'success' : 'danger', ok ? 'Nome atualizado' : 'Não foi possível renomear');
  }

  // Renderiza a RAIZ do fluxo com slots de inserção entre etapas; cards Condição
  // desenham os dois ramos (SIM/NÃO) logo abaixo, com seus filhos.
  const flowNodes = [];
  rootSteps.forEach((s, i) => {
    flowNodes.push(<DropSlot key={'slot-' + i} index={i} over={over === i} onOver={setOver} onDrop={onDrop} horizontal={horizontal} arrow={i > 0} />);
    flowNodes.push(
      <div key={s.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0, width: s.tipo === 'Condição' ? '100%' : 'auto' }}>
        <StepCard step={s} index={i} selected={selId === s.id} onSelect={setSelId} onDelete={deleteStep} onDragStart={onDragStart} compact={compact} opts={opts} />
        {s.tipo === 'Condição' && (
          <React.Fragment>
            <ForkConnector />
            <BranchSplit cond={s} steps={steps} selId={selId} onSelect={setSelId} onDelete={deleteStep} onAddChild={addChild} opts={opts} compact={compact} />
          </React.Fragment>
        )}
      </div>
    );
  });
  flowNodes.push(<DropSlot key={'slot-end'} index={rootSteps.length} over={over === rootSteps.length} onOver={setOver} onDrop={onDrop} horizontal={horizontal} />);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Barra do construtor — fixa no topo enquanto o canvas rola. Duas linhas:
          (1) navegação + nome + status + ações principais; (2) vínculos da campanha
          (webhook + marca). Separar evita a barra quebrar de forma imprevisível. */}
      <div style={{ position: 'sticky', top: 0, zIndex: 5, background: 'var(--surface-app)', display: 'flex', flexDirection: 'column', gap: 8, paddingBlock: 8, borderBottom: '1px solid var(--border-subtle)', boxShadow: '0 calc(-1 * var(--content-pad)) 0 var(--surface-app)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Button variant="ghost" size="sm" iconLeft="arrow-left" onClick={handleBack}>Campanhas</Button>
          <Icon name="chevron-right" size={15} style={{ color: 'var(--text-subtle)' }} />
          {editingName ? (
            <input
              autoFocus
              value={nomeDraft}
              onChange={(e) => setNomeDraft(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') { setNomeDraft(nome); setEditingName(false); } }}
              style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--fw-bold)', color: 'var(--text-strong)', background: 'var(--surface-sunken)', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', padding: '2px 8px', fontFamily: 'var(--font-sans)', minWidth: 220 }}
            />
          ) : (
            <button
              onClick={() => { setNomeDraft(nome); setEditingName(true); }}
              title="Renomear campanha"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: '2px 4px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'var(--font-sans)', minWidth: 0 }}
            >
              <span style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--fw-bold)', color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nome}</span>
              <Icon name="pencil" size={14} style={{ color: 'var(--text-subtle)', flex: 'none' }} />
            </button>
          )}
          <Badge tone={DB.optionSets.StatusCampanha[status] || 'neutral'} dot>{status}</Badge>
          <div style={{ marginInlineStart: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            {dirty && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Alterações não salvas</span>}
            <Button variant="secondary" size="sm" iconLeft={status === 'Ativa' ? 'pause' : 'play'} onClick={toggleActive}>{status === 'Ativa' ? 'Pausar' : 'Ativar'}</Button>
            <Button variant="primary" size="sm" iconLeft="check" onClick={save} loading={saving} disabled={!dirty || saving}>{saving ? 'Salvando…' : 'Salvar fluxo'}</Button>
          </div>
        </div>
        {/* Linha 2: vínculos da campanha (webhook + identidade). */}
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 12, flexWrap: 'wrap' }}>
          {/* WEB-1: webhook vinculado — define qual token dispara esta campanha */}
          {tokens.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: '8px 12px' }}>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontWeight: 'var(--fw-medium)', whiteSpace: 'nowrap' }}>Webhook</span>
              <div style={{ minWidth: 180 }}>
                <Select
                  value={webhookId}
                  onChange={(e) => saveWebhook(e.target.value)}
                  options={[{ value: '', label: 'Todos os webhooks' }, ...tokens.map((t) => ({ value: t.id, label: t.nome }))]}
                  aria-label="Webhook vinculado à campanha"
                />
              </div>
            </div>
          )}
          {/* Identidade desta campanha — sempre visível (mesmo sem marcas cadastradas). */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 280px', minWidth: 0,
            background: 'var(--surface-card)', border: '1px solid var(--border-subtle)',
            borderInlineStart: `3px solid ${activeBrand?.cor || 'var(--accent)'}`,
            borderRadius: 'var(--radius-sm)', padding: '8px 12px',
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 'var(--radius-sm)', flex: 'none', overflow: 'hidden',
              background: activeBrand?.cor || 'var(--accent-soft)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: '1px solid var(--border-subtle)',
            }}>
              {activeBrand?.logo_url
                ? <img src={activeBrand.logo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{(activeBrand?.nome || 'L').charAt(0).toUpperCase()}</span>}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 'var(--ls-eyebrow)', fontWeight: 'var(--fw-semibold)' }}>
                Esta campanha usa a marca
              </div>
              {brands.length > 0 ? (
                <div style={{ minWidth: 160, maxWidth: 240 }}>
                  <Select
                    value={brandId}
                    onChange={(e) => saveBrand(e.target.value)}
                    options={[{ value: '', label: brands[0] ? `Padrão (${brands[0].nome || '1ª marca'})` : 'Marca padrão' }, ...brands.map((b) => ({ value: b.id, label: b.nome || 'Sem nome' }))]}
                    aria-label="Marca vinculada à campanha"
                  />
                </div>
              ) : (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                  Nenhuma marca ainda — crie em Integrações → Identidade dos e-mails
                </div>
              )}
            </div>
            {activeBrand && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flex: 'none' }}>
                <span style={{ width: 18, height: 18, borderRadius: 4, background: activeBrand.cor || '#ff6800', border: '1px solid var(--border-subtle)' }} title={activeBrand.cor || ''} />
                <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-subtle)' }}>{activeBrand.modo === 'light' ? 'Tema claro' : 'Tema escuro'}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="kbly-builder-grid" style={{ gap: 16, alignItems: 'start' }}>
        {/* Paleta */}
        <Palette onDragStart={onDragStart} onAdd={addStep} />

        {/* Canvas — drop em qualquer lugar adiciona ao final; os slots inserem no meio. */}
        <div
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={(e) => { e.preventDefault(); onDrop(rootSteps.length); }}
          style={{ background: 'radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px) 0 0 / 16px 16px, var(--surface-sunken)', border: '1px dashed var(--border-default)', borderRadius: 'var(--radius-md)', padding: horizontal ? '24px 16px' : '16px 24px', minHeight: 360, overflowX: horizontal ? 'auto' : 'visible' }}>
          {steps.length === 0 ? (
            <div style={{ height: 320, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--text-muted)', textAlign: 'center' }}>
              <Icon name="git-branch" size={28} />
              <div style={{ fontSize: 'var(--text-sm)' }}>Arraste um card da paleta para cá — ou clique nele — para começar o fluxo.</div>
            </div>
          ) : (
            // Largura máxima consistente: os ramos da Condição alinham com a coluna
            // dos cards em vez de esticar o canvas inteiro (larguras desalinhadas).
            <div style={{ display: 'flex', flexDirection: horizontal ? 'row' : 'column', alignItems: 'center', ...(horizontal ? {} : { width: '100%', maxWidth: 620, marginInline: 'auto' }) }}>
              {flowNodes}
            </div>
          )}
        </div>

        {/* Inspetor + meta */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <AISuggestion key={campaign.id} title="Sugestão da IA — esta campanha" load={(force) => KoblyAI.suggestForCampaign({ nome: campaign.nome, criticidade: campaign.stats && campaign.stats.criticidade }, force)} />
          <Card style={{ minHeight: 200 }}>
            <Inspector
              step={selStep}
              onChange={updateStep}
              opts={opts}
              brand={activeBrand}
              onEditEmail={(id) => {
                const found = id ? (opts.emails || []).find((e) => e.id === id) : null;
                // Sem id ou sem template: abre editor vazio para criar e vincular à etapa.
                setEmailModal(found || { titulo: '', assunto: '', remetente: '', corpoHtml: '' });
              }}
              onCopyEmailFromModel={async (sourceId, stepId) => {
                const src = (opts.emails || []).find((e) => e.id === sourceId);
                if (!src) return { error: 'Modelo não encontrado' };
                const { error, id } = await KoblyApi.createEmail({
                  titulo: src.titulo || 'E-mail da etapa',
                  assunto: src.assunto || '',
                  remetente: src.remetente || '',
                  corpoHtml: src.corpoHtml || '',
                }, campaign.empresaId);
                if (error) return { error };
                if (id && stepId) {
                  setSteps((prev) => prev.map((s) => {
                    if (s.id !== stepId) return s;
                    return { ...s, config: { ...(s.config || {}), emailId: id } };
                  }));
                  setDirty(true);
                  setSelId(stepId);
                }
                await optsA.reload();
                return { error: null, id };
              }}
              onEditWhatsApp={(id) => setWhatsappModal((opts.whatsappMessages || []).find((m) => m.id === id) || { titulo: 'Nova mensagem', corpoTexto: '' })}
              onEditSms={(id) => setSmsModal((opts.smsMessages || []).find((m) => m.id === id) || { titulo: 'Nova mensagem', corpoTexto: '' })}
            />
          </Card>
          <Card icon="flag" title="Tags-meta (encerrar lead)">
            <p style={{ margin: '0 0 12px', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 'var(--lh-snug)' }}>Quando o lead recebe um evento com alguma destas tags, o fluxo é encerrado para ele.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(opts.tags || []).map((t) => {
                const on = tagsMeta.includes(t.id);
                return <button key={t.id} onClick={() => toggleMeta(t.id)} style={{ cursor: 'pointer', whiteSpace: 'nowrap', border: `1px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'}`, background: on ? 'var(--accent-soft)' : 'var(--surface-sunken)', color: on ? 'var(--accent)' : 'var(--text-muted)', borderRadius: 'var(--radius-pill)', padding: '4px 10px', fontSize: 'var(--text-xs)', fontWeight: 'var(--fw-semibold)', fontFamily: 'var(--font-sans)' }}>{t.nome}</button>;
              })}
            </div>
          </Card>
        </div>
      </div>

      {emailModal !== null && React.createElement(KoblyEmailEditor, {
        email: emailModal,
        brand: activeBrand,
        brandContext: 'campanha',
        draftScope: `${campaign.id}:${selId || ''}`,
        onClose: () => setEmailModal(null),
        onSave: async (p) => {
          if (!p) return { error: 'Dados inválidos' };
          if (p.id) {
            const { error } = await KoblyApi.updateEmail(p.id, p);
            if (error) return { error };
            await optsA.reload();
            return { error: null };
          }
          // Cria template novo e vincula à etapa selecionada (sem lista pré-pronta).
          const { error, id } = await KoblyApi.createEmail({
            titulo: p.titulo, assunto: p.assunto, remetente: p.remetente, corpoHtml: p.corpoHtml,
          }, campaign.empresaId);
          if (error) return { error };
          if (id && selId) {
            setSteps((prev) => prev.map((s) => {
              if (s.id !== selId) return s;
              return { ...s, config: { ...(s.config || {}), emailId: id } };
            }));
            setDirty(true);
          }
          await optsA.reload();
          return { error: null, id };
        },
      })}
      {whatsappModal !== null && React.createElement(KoblyWhatsAppEditor, {
        message: whatsappModal,
        objetivo: objetivoCampanha,
        draftScope: `${campaign.id}:${selId || ''}`,
        onClose: () => setWhatsappModal(null),
        onSave: async (p) => {
          if (!p) return { error: 'Dados inválidos' };
          if (p.id) {
            const { error } = await KoblyApi.saveWhatsappMessage({
              id: p.id, titulo: p.titulo, corpoTexto: p.corpoTexto, botoes: p.botoes, templateId: p.templateId, templateVars: p.templateVars,
            });
            if (error) return { error };
            await optsA.reload();
            return { error: null };
          }
          const { error, id } = await KoblyApi.saveWhatsappMessage({
            titulo: p.titulo, corpoTexto: p.corpoTexto, botoes: p.botoes, templateId: p.templateId, templateVars: p.templateVars,
          }, campaign.empresaId);
          if (error) return { error };
          if (id && selId) {
            setSteps((prev) => prev.map((s) => {
              if (s.id !== selId) return s;
              return { ...s, config: { ...(s.config || {}), whatsappMessageId: id } };
            }));
            setDirty(true);
          }
          await optsA.reload();
          return { error: null, id };
        },
      })}
      {smsModal !== null && React.createElement(KoblySmsEditor, {
        message: smsModal,
        draftScope: `${campaign.id}:${selId || ''}`,
        onClose: () => setSmsModal(null),
        onSave: async (p) => {
          if (!p) return { error: 'Dados inválidos' };
          if (p.id) {
            const { error } = await KoblyApi.saveSmsMessage({ id: p.id, titulo: p.titulo, corpoTexto: p.corpoTexto });
            if (error) return { error };
            await optsA.reload();
            return { error: null };
          }
          const { error, id } = await KoblyApi.saveSmsMessage({ titulo: p.titulo, corpoTexto: p.corpoTexto }, campaign.empresaId);
          if (error) return { error };
          if (id && selId) {
            setSteps((prev) => prev.map((s) => {
              if (s.id !== selId) return s;
              return { ...s, config: { ...(s.config || {}), smsMessageId: id } };
            }));
            setDirty(true);
          }
          await optsA.reload();
          return { error: null, id };
        },
      })}
    </div>
  );
}
export { KoblyFlowBuilder };
