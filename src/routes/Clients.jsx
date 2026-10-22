import { useState } from 'react';
import { KoblyApi } from '@/api/mockApi.js';
import { KoblyMockDB, SEGMENTOS } from '@/api/mockData.js';
import { Avatar, Badge, Button, DataTable, IconButton, Icon, Input, PageHeader, Select } from '@/ds';
import { useAsync } from '@/lib/hooks.jsx';
import { isDocumentoBr } from '@/lib/documento.js';
import { Modal, ErrorState, SkeletonTable, EmptyState, DocumentoField } from '@/lib/ui.jsx';
import { useKobly } from '@/store/store.jsx';

// Kobly — Clientes (Gestor/Admin). Lista e gerencia contas de cliente (Empresa).
// Criar conta = RPC create_managed_org (vincula a agência como membro) + convite
// por e-mail ao cliente via Edge Function invite-client (MARCA-2). KoblyClients

function AccountModal({ account, onClose, onSubmit }) {
  const editing = !!account;
  const [nome, setNome] = useState(account ? account.nome : '');
  const [segmento, setSegmento] = useState(account ? (account.segmento || 'Outro') : 'Suplementos');
  // CPF/CNPJ da conta — exigido pelo Asaas no checkout. Guardado normalizado.
  const [documento, setDocumento] = useState(account ? (account.documento || '') : '');
  // MARCA-2: e-mail do cliente (para convite) + seleção de plano inicial.
  const [email, setEmail] = useState(account ? (account.clienteEmail || '') : '');
  const [planoId, setPlanoId] = useState('');
  const [busy, setBusy] = useState(false);
  // Carrega planos ativos para o seletor (só na criação — edição não muda plano aqui).
  const plansA = useAsync(() => (editing ? Promise.resolve([]) : KoblyApi.getPlans()), [editing]);
  const planos = (plansA.data?.planos || []).filter((p) => !p.deleted);

  // Documento é opcional no cadastro, mas se preenchido tem que ser válido —
  // o CHECK do banco rejeitaria e o erro chegaria cru.
  const docOk = !documento || isDocumentoBr(documento);

  async function submit() {
    if (!nome.trim() || !docOk) return;
    setBusy(true);
    await onSubmit({ nome, segmento, documento, email: editing ? undefined : email, planoId: editing ? undefined : planoId });
    setBusy(false);
  }
  return (
    <Modal open onClose={onClose} title={editing ? 'Editar conta' : 'Cadastrar nova conta'}
      subtitle={editing ? 'Atualize os dados básicos da conta.' : 'A conta é criada sob a sua agência. O cliente recebe um convite por e-mail para definir a senha e acessar.'}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" iconLeft={editing ? 'check' : 'plus'} disabled={busy || !nome.trim() || !docOk} onClick={submit}>{busy ? 'Salvando…' : (editing ? 'Salvar' : 'Criar conta')}</Button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label="Nome da empresa" placeholder="Ex.: Loja do João" value={nome} onChange={(e) => setNome(e.target.value)} />
        <Select label="Segmento" value={segmento} onChange={(e) => setSegmento(e.target.value)} options={SEGMENTOS} />
        <DocumentoField
          label="CPF / CNPJ (opcional)"
          value={documento}
          onChange={setDocumento}
          hint="Usado na cobrança pelo Asaas. Já aceita o CNPJ alfanumérico (ex.: 12.ABC.345/01DE-35)."
        />
        {!editing && (
          <>
            <Input label="E-mail do cliente" icon="mail" type="email" placeholder="cliente@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            {planos.length > 0 && (
              <Select
                label="Plano inicial"
                value={planoId}
                onChange={(e) => setPlanoId(e.target.value)}
                options={[{ value: '', label: 'Starter (padrão)' }, ...planos.map((p) => ({ value: p.id, label: `${p.nome} — até ${p.limiteCampanhas} campanhas` }))]}
              />
            )}
            {email.trim() && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                <Icon name="info" size={15} style={{ color: 'var(--accent)' }} />
                O cliente receberá um convite por e-mail para definir a senha e acessar a conta.
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function KoblyClients() {
  const store = useKobly();
  const a = useAsync(() => KoblyApi.listClients(), [store.role]);
  const [modal, setModal] = useState(false);   // novo
  const [editing, setEditing] = useState(null); // conta em edição
  const [access, setAccess] = useState(null);   // convite sem e-mail automático: link para o gestor repassar
  const DB = KoblyMockDB;

  async function create({ nome, segmento, documento, email, planoId }) {
    const r = await KoblyApi.createOrganization({ nome, segmento, documento, email, planoId });
    if (r.error) { store.notify('danger', 'Não foi possível criar a conta.'); return; }
    if (r.documentoError) store.notify('warning', 'Conta criada, mas o CPF/CNPJ não foi salvo — edite a conta para informar.');
    // MARCA-2: feedback granular sobre o convite.
    if (r.invited && r.accessLink) setAccess({ nome, email, link: r.accessLink });
    else if (r.invited) store.notify('success', `Conta "${nome}" criada — convite enviado para ${email}`);
    else if (r.alreadyExists) store.notify('warning', `Conta criada, mas ${email} já tem cadastro`);
    else if (r.inviteError) store.notify('warning', `Conta criada, mas o convite falhou: ${r.inviteError}`);
    else store.notify('success', `Conta "${nome}" criada`);
    setModal(false);
    a.reload();
  }
  async function saveEdit({ nome, segmento, documento }) {
    const { error } = await KoblyApi.updateOrganization(editing.id, { nome, segmento, documento });
    if (error) { store.notify('danger', 'Não foi possível salvar a conta.'); return; }
    store.notify('success', 'Conta atualizada');
    setEditing(null);
    a.reload();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {access && (
        <Modal open onClose={() => setAccess(null)} title="Conta criada — envie o acesso ao cliente"
          subtitle={`O envio automático de e-mail ainda não está ativo. Copie o link e mande para ${access.email}: ele define a senha e entra na conta "${access.nome}". O link vale por 7 dias e só funciona uma vez.`}
          footer={<><Button variant="ghost" onClick={() => setAccess(null)}>Fechar</Button>
            <Button variant="primary" iconLeft="copy" onClick={() => { navigator.clipboard?.writeText(access.link); store.notify('success', 'Link copiado'); }}>Copiar link</Button></>}>
          <Input label="Link de acesso" value={access.link} readOnly onChange={() => {}} onFocus={(e) => e.target.select()} />
        </Modal>
      )}
      <PageHeader action={<Button variant="primary" iconLeft="plus" onClick={() => setModal(true)}>Cadastrar nova conta</Button>}>
        Contas de cliente que você gerencia como agência. Cada conta isola leads, campanhas e domínios de envio.
      </PageHeader>
      {a.status === 'loading' ? (
        <SkeletonTable />
      ) : (
        <div style={{ background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
          {a.status === 'error' ? (
            <ErrorState message={a.error} onRetry={a.reload} compact />
          ) : (
            <DataTable
              rowKey="id"
              zebra
              empty={(
                <EmptyState
                  compact
                  icon="building-2"
                  title="Nenhuma conta ainda"
                  message="Cadastre a primeira conta de cliente para gerenciar leads, campanhas e domínios de envio."
                  action={<Button variant="primary" iconLeft="plus" onClick={() => setModal(true)}>Cadastrar nova conta</Button>}
                />
              )}
              columns={[
                { key: 'nome', header: 'Conta', render: (r) => (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                    <Avatar name={r.nome} tone="teal" size="sm" />
                    <div>
                      <div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{r.nome}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{r.clienteEmail || r.fundadorEmail || '—'}</div>
                    </div>
                  </div>
                ) },
                { key: 'segmento', header: 'Segmento' },
                { key: 'plano', header: 'Plano', render: (r) => <Badge tone="neutral">{r.plano}</Badge> },
                { key: 'leads', header: 'Leads', align: 'end', render: (r) => KoblyApi.br(r.leads) },
                { key: 'campanhasAtivas', header: 'Ativas', align: 'end' },
                { key: 'criticidade', header: 'Criticidade', render: (r) => <Badge tone={DB.optionSets.StatusCriticidade[r.criticidade] || 'neutral'} dot>{r.criticidade}</Badge> },
                { key: 'acao', header: '', align: 'end', width: 60, render: (r) => (
                  <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                    <IconButton icon="pencil" size="sm" aria-label="Editar" onClick={() => setEditing(r)} />
                  </div>
                ) },
              ]}
              rows={a.data || []}
            />
          )}
        </div>
      )}
      {modal && <AccountModal onClose={() => setModal(false)} onSubmit={create} />}
      {editing && <AccountModal account={editing} onClose={() => setEditing(null)} onSubmit={saveEdit} />}
    </div>
  );
}

export { KoblyClients };
