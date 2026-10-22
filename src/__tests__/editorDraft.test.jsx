import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

const notify = vi.fn();
vi.mock('@/store/store.jsx', () => ({ useKobly: () => ({ notify, session: { email: 'a@b.test' } }) }));
vi.mock('@/lib/responsive.jsx', () => ({ useBreakpoint: () => ({ isNarrow: false }) }));
vi.mock('@/api/ai.js', () => ({ KoblyAI: {} }));
vi.mock('@/api/mockApi.js', () => ({ KoblyApi: { listWhatsappTemplates: vi.fn().mockResolvedValue([]) } }));

beforeEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); vi.useRealTimers(); });
const sms = async () => (await import('@/routes/SmsEditor.jsx')).KoblySmsEditor;
const txt = () => document.querySelector('textarea');
const wait = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));

describe('rascunho do editor sobrevive a sair/recarregar', () => {
  it('o que foi digitado volta ao reabrir (mesma mensagem) e avisa a pessoa', async () => {
    const Ed = await sms(); const msg = { id: 'm1', titulo: 'Oi', corpoTexto: 'texto salvo' };
    const a = render(<Ed message={msg} onClose={() => {}} onSave={async () => ({})} />);
    fireEvent.change(txt(), { target: { value: 'texto novo ainda não salvo' } });
    await wait(400); a.unmount();                                   // “recarregou a página”
    render(<Ed message={msg} onClose={() => {}} onSave={async () => ({})} />);
    expect(txt().value).toBe('texto novo ainda não salvo');
    expect(notify).toHaveBeenCalledWith('info', expect.stringMatching(/Recuperamos/));
  });
  it('grava ao esconder a aba mesmo antes da pausa de digitação', async () => {
    const Ed = await sms(); const msg = { id: 'm2', titulo: 'Oi', corpoTexto: 'a' };
    render(<Ed message={msg} onClose={() => {}} onSave={async () => ({})} />);
    fireEvent.change(txt(), { target: { value: 'digitei e troquei de aba' } });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange'));
    expect(Object.keys(localStorage).some((k) => k.startsWith('kobly:editdraft:sms:m2'))).toBe(true);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  it('salvar apaga o rascunho; mensagem sem alteração não deixa rascunho', async () => {
    const Ed = await sms(); const msg = { id: 'm3', titulo: 'Oi', corpoTexto: 'a' };
    const onClose = vi.fn();
    render(<Ed message={msg} onClose={onClose} onSave={async () => ({})} />);
    await wait(400); expect(localStorage.length).toBe(0);           // nada mudou, nada guardado
    fireEvent.change(txt(), { target: { value: 'b' } }); await wait(400);
    expect(localStorage.length).toBe(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Salvar mensagem/ })); });
    expect(localStorage.length).toBe(0); expect(onClose).toHaveBeenCalled();
  });
  it('descartar de propósito também apaga; cancelar o descarte mantém', async () => {
    const Ed = await sms(); const msg = { id: 'm4', titulo: 'Oi', corpoTexto: 'a' };
    const onClose = vi.fn();
    render(<Ed message={msg} onClose={onClose} onSave={async () => ({})} />);
    fireEvent.change(txt(), { target: { value: 'b' } }); await wait(400);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: /Cancelar/ }));
    expect(onClose).not.toHaveBeenCalled(); expect(localStorage.length).toBe(1);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: /Cancelar/ }));
    expect(onClose).toHaveBeenCalled(); expect(localStorage.length).toBe(0);
  });
  it('rascunhos de mensagens diferentes não se misturam', async () => {
    const Ed = await sms();
    const a = render(<Ed message={{ id: 'x1', titulo: 'A', corpoTexto: 'a' }} onClose={() => {}} onSave={async () => ({})} />);
    fireEvent.change(txt(), { target: { value: 'rascunho do x1' } }); await wait(400); a.unmount();
    render(<Ed message={{ id: 'x2', titulo: 'B', corpoTexto: 'b' }} onClose={() => {}} onSave={async () => ({})} />);
    expect(txt().value).toBe('b');
  });
  it('WhatsApp: modelo e variáveis escolhidos também voltam', async () => {
    const { KoblyApi } = await import('@/api/mockApi.js');
    KoblyApi.listWhatsappTemplates.mockResolvedValue([{ id: 't1', name: 'carrinho', status: 'APPROVED', body_text: 'Oi {{1}}', variable_count: 1 }]);
    const { KoblyWhatsAppEditor: Ed } = await import('@/routes/WhatsAppEditor.jsx');
    const msg = { id: 'w1', titulo: 'x', corpoTexto: '', botoes: [] };
    const a = render(<Ed message={msg} objetivo="Pix Gerado" onClose={() => {}} onSave={async () => ({})} />);
    const sel = await screen.findByLabelText(/Modelo aprovado da Meta/);
    await wait(10);
    fireEvent.change(sel, { target: { value: 't1' } });
    fireEvent.change(await screen.findByLabelText(/Variável \{\{1\}\}/), { target: { value: 'produto' } });
    await wait(400); a.unmount();
    render(<Ed message={msg} objetivo="Pix Gerado" onClose={() => {}} onSave={async () => ({})} />);
    expect((await screen.findByLabelText(/Variável \{\{1\}\}/)).value).toBe('produto');
  });
});
