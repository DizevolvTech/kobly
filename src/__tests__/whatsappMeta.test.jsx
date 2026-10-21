import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

const api = { whatsappAccount: vi.fn(), listWhatsappTemplates: vi.fn() };
vi.mock('@/api/mockApi.js', () => ({ KoblyApi: api }));
const notify = vi.fn();
vi.mock('@/store/store.jsx', () => ({ useKobly: () => ({ notify }) }));

const ACC = { id: 'a', status: 'connected', display_phone: '+55 11 98888-7777', verified_name: 'Loja Teste', quality_rating: 'GREEN', messaging_limit: 'TIER_1K', webhook_url: 'https://api.test/webhooks/whatsapp/abc', verify_token: 'vt-123', has_app_secret: true };
beforeEach(() => { cleanup(); vi.clearAllMocks(); });

async function load() { const m = await import('@/routes/WhatsappMeta.jsx'); return m.WhatsappMetaTab; }

describe('aba WhatsApp (Meta)', () => {
  it('sem conta: mostra o formulário e só habilita Conectar com dados válidos', async () => {
    api.whatsappAccount.mockResolvedValue({ error: null, connected: false, account: null });
    api.listWhatsappTemplates.mockResolvedValue([]);
    const Tab = await load(); render(<Tab empresaId="o1" />);
    const btn = await screen.findByRole('button', { name: /^Conectar$/ });
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/ID da conta do WhatsApp Business/), { target: { value: '123456789012345' } });
    fireEvent.change(screen.getByLabelText(/ID do número/), { target: { value: '109876543210987' } });
    fireEvent.change(screen.getByLabelText(/Token de acesso/), { target: { value: 'EAAGtokenpermanentelongo123' } });
    expect(btn.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/Token de acesso/), { target: { value: 'curto' } });
    expect(btn.disabled).toBe(true);                       // token curto demais
    fireEvent.change(screen.getByLabelText(/Token de acesso/), { target: { value: 'EAAGtokenpermanentelongo123' } });
    fireEvent.change(screen.getByLabelText(/ID do número/), { target: { value: 'abc' } });
    expect(btn.disabled).toBe(true);                       // ID com letras
  });
  it('conectar envia os dados à rota e mostra o erro da Meta sem perder o formulário', async () => {
    api.whatsappAccount.mockImplementation(async (action) => (action === 'status' ? { error: null, account: null } : { error: 'O token de acesso da Meta é inválido ou expirou.' }));
    api.listWhatsappTemplates.mockResolvedValue([]);
    const Tab = await load(); render(<Tab empresaId="o1" />);
    await screen.findByRole('button', { name: /^Conectar$/ });
    fireEvent.change(screen.getByLabelText(/ID da conta do WhatsApp Business/), { target: { value: '123456789012345' } });
    fireEvent.change(screen.getByLabelText(/ID do número/), { target: { value: '109876543210987' } });
    fireEvent.change(screen.getByLabelText(/Token de acesso/), { target: { value: 'EAAGtokenpermanentelongo123' } });
    fireEvent.click(screen.getByRole('button', { name: /^Conectar$/ }));
    await screen.findByText(/inválido ou expirou/);
    expect(api.whatsappAccount).toHaveBeenCalledWith('connect', expect.objectContaining({ waba_id: '123456789012345', phone_number_id: '109876543210987' }), 'o1');
    expect(screen.getByLabelText(/ID do número/).value).toBe('109876543210987');
  });
  it('conectado: mostra número, qualidade, URL do webhook e os modelos com status', async () => {
    api.whatsappAccount.mockResolvedValue({ error: null, connected: true, account: ACC });
    api.listWhatsappTemplates.mockResolvedValue([
      { id: 't1', name: 'carrinho', language: 'pt_BR', category: 'MARKETING', status: 'APPROVED', body_text: 'Oi {{1}}', variable_count: 1 },
      { id: 't2', name: 'promo', language: 'pt_BR', category: 'MARKETING', status: 'REJECTED', body_text: 'x', rejected_reason: 'INVALID_FORMAT', variable_count: 0 },
    ]);
    const Tab = await load(); render(<Tab empresaId="o1" />);
    await screen.findByText(/Conectado · \+55 11 98888-7777/);
    expect(screen.getByText('Qualidade alta')).toBeTruthy();
    expect(screen.getByDisplayValue('https://api.test/webhooks/whatsapp/abc')).toBeTruthy();
    expect(screen.getByText('Aprovado')).toBeTruthy(); expect(screen.getByText('Rejeitado')).toBeTruthy();
    expect(screen.getByText(/Motivo: INVALID_FORMAT/)).toBeTruthy();
  });
  it('teste de envio: só lista modelos aprovados, pede as variáveis e manda pela rota', async () => {
    api.whatsappAccount.mockImplementation(async (action) => (action === 'status' ? { error: null, account: ACC } : { error: null, ok: true }));
    api.listWhatsappTemplates.mockResolvedValue([
      { id: 't1', name: 'carrinho', status: 'APPROVED', body_text: 'Oi {{1}}', variable_count: 1, category: 'MARKETING', language: 'pt_BR' },
      { id: 't2', name: 'promo', status: 'PENDING', body_text: 'x', variable_count: 0, category: 'MARKETING', language: 'pt_BR' },
    ]);
    const Tab = await load(); render(<Tab empresaId="o1" />);
    const select = await screen.findByLabelText(/Modelo aprovado/);
    const opts = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(opts).toContain('carrinho'); expect(opts).not.toContain('promo');
    fireEvent.change(select, { target: { value: 't1' } });
    fireEvent.change(await screen.findByLabelText(/variáveis/), { target: { value: 'Ana' } });
    fireEvent.change(document.querySelector('input[type=tel]'), { target: { value: '11988887777' } });
    fireEvent.click(screen.getByRole('button', { name: /^Enviar teste$/ }));
    await waitFor(() => expect(api.whatsappAccount).toHaveBeenCalledWith('send_test', expect.objectContaining({ template_id: 't1', variables: ['Ana'] }), 'o1'));
    await screen.findByText(/Mensagem enviada/);
  });
  it('avisa quando falta o segredo do app (avisos de entrega seriam recusados)', async () => {
    api.listWhatsappTemplates.mockResolvedValue([]);
    api.whatsappAccount.mockResolvedValue({ error: null, account: { ...ACC, has_app_secret: false } });
    const Tab = await load(); const { unmount } = render(<Tab empresaId="o1" />);
    await screen.findByText(/Sem o segredo do app/); unmount();
    api.whatsappAccount.mockResolvedValue({ error: null, account: ACC });
    render(<Tab empresaId="o1" />);
    await screen.findByText(/Conectado ·/);
    expect(screen.queryByText(/Sem o segredo do app/)).toBeNull();
  });
  it('erro de conexão (token expirado) aparece como alerta e permite reconectar', async () => {
    api.whatsappAccount.mockResolvedValue({ error: null, account: { ...ACC, status: 'error', last_error: 'O token de acesso da Meta é inválido ou expirou.' } });
    api.listWhatsappTemplates.mockResolvedValue([]);
    const Tab = await load(); render(<Tab empresaId="o1" />);
    await screen.findByText(/Problema na conexão/);
    expect(screen.getByText(/inválido ou expirou/)).toBeTruthy();
  });
});
