import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const api = { listClients: vi.fn(), getPlans: vi.fn(), createOrganization: vi.fn() };
vi.mock('@/api/mockApi.js', () => ({ KoblyApi: api }));
const notify = vi.fn();
vi.mock('@/store/store.jsx', () => ({ useKobly: () => ({ notify, role: 'Gestor' }) }));

beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  api.listClients.mockResolvedValue([]); api.getPlans.mockResolvedValue({ planos: [] });
});
async function criar(result) {
  api.createOrganization.mockResolvedValue({ error: null, org: { id: 'o1' }, ...result });
  const { KoblyClients } = await import('@/routes/Clients.jsx');
  render(<KoblyClients />);
  fireEvent.click((await screen.findAllByRole('button', { name: /Cadastrar nova conta/ }))[0]);
  fireEvent.change(await screen.findByLabelText(/Nome da empresa/), { target: { value: 'Loja do João' } });
  fireEvent.change(screen.getByLabelText(/E-mail do cliente/), { target: { value: 'joao@loja.test' } });
  fireEvent.click(screen.getByRole('button', { name: /Criar conta/ }));
}

describe('cadastro de conta pelo gestor (convite)', () => {
  it('sem e-mail automático: mostra o link de acesso para o gestor copiar', async () => {
    await criar({ invited: true, emailed: false, accessLink: 'https://app.kobly.test/#type=recovery&token=abc' });
    const link = await screen.findByLabelText(/Link de acesso/);
    expect(link.value).toBe('https://app.kobly.test/#type=recovery&token=abc');
    expect(screen.getByText(/joao@loja\.test/)).toBeTruthy();
    expect(api.createOrganization).toHaveBeenCalledWith(expect.objectContaining({ nome: 'Loja do João', email: 'joao@loja.test' }));
  });
  it('com e-mail enviado: só avisa que o convite foi enviado, sem mostrar link', async () => {
    await criar({ invited: true, emailed: true, accessLink: null });
    await waitFor(() => expect(notify).toHaveBeenCalledWith('success', expect.stringMatching(/convite enviado para joao@loja\.test/)));
    expect(screen.queryByLabelText(/Link de acesso/)).toBeNull();
  });
  it('e-mail que já tem cadastro: avisa sem criar convite', async () => {
    await criar({ invited: false, alreadyExists: true });
    await waitFor(() => expect(notify).toHaveBeenCalledWith('warning', expect.stringMatching(/já tem cadastro/)));
  });
});
