import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

const api = { listWhatsappTemplates: vi.fn() };
vi.mock('@/api/mockApi.js', () => ({ KoblyApi: api }));
vi.mock('@/api/ai.js', () => ({ KoblyAI: {} }));
vi.mock('@/store/store.jsx', () => ({ useKobly: () => ({ notify: vi.fn() }) }));
vi.mock('@/lib/responsive.jsx', () => ({ useBreakpoint: () => ({ isNarrow: false }) }));

const TPLS = [
  { id: 't1', name: 'carrinho', status: 'APPROVED', body_text: 'Oi {{1}}, voltou {{2}}?', variable_count: 2 },
  { id: 't2', name: 'promo', status: 'PENDING', body_text: 'x', variable_count: 0 },
];
beforeEach(() => { cleanup(); vi.clearAllMocks(); api.listWhatsappTemplates.mockResolvedValue(TPLS); });
async function open(props = {}) { const { KoblyWhatsAppEditor: Ed } = await import('@/routes/WhatsAppEditor.jsx'); const onSave = vi.fn().mockResolvedValue({}); render(<Ed message={null} objetivo="Pix Gerado" onClose={() => {}} onSave={onSave} {...props} />); return onSave; }

describe('editor de WhatsApp (modelo da Meta)', () => {
  it('só oferece modelos aprovados e salva modelo + variáveis escolhidas', async () => {
    const onSave = await open();
    const sel = await screen.findByLabelText(/Modelo aprovado da Meta/);
    await waitFor(() => expect(Array.from(sel.querySelectorAll('option')).map((o) => o.textContent)).toContain('carrinho'));
    expect(Array.from(sel.querySelectorAll('option')).map((o) => o.textContent)).not.toContain('promo');
    fireEvent.change(sel, { target: { value: 't1' } });
    fireEvent.change(await screen.findByLabelText(/Variável \{\{2\}\}/), { target: { value: 'cta_link' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar mensagem/ }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const p = onSave.mock.calls[0][0];
    expect(p.templateId).toBe('t1'); expect(p.templateVars).toEqual(['nome', 'cta_link']); expect(p.corpoTexto).toBe('Oi {{1}}, voltou {{2}}?');
  });
  it('sem modelo: avisa que o passo não envia e salva sem modelo', async () => {
    const onSave = await open();
    await screen.findByText(/não envia/);
    fireEvent.click(screen.getByRole('button', { name: /Salvar mensagem/ }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].templateId).toBeNull(); expect(onSave.mock.calls[0][0].templateVars).toEqual([]);
  });
  it('reabrir mensagem já ligada a um modelo mostra o modelo e as variáveis salvas', async () => {
    await open({ message: { id: 'm', titulo: 'x', corpoTexto: '', botoes: [], templateId: 't1', templateVars: ['produto', 'valor'] } });
    expect((await screen.findByLabelText(/Variável \{\{1\}\}/)).value).toBe('produto');
    expect(screen.getByLabelText(/Variável \{\{2\}\}/).value).toBe('valor');
  });
});
