// Fumaça de interface: para cada papel, abre TODAS as telas da navegação com um banco
// vazio e confirma que nenhuma cai no "Algo deu errado" (crash de render).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { makeFakeSupabase } from './fakeSupabase.js';
import { KoblyMockDB as DB } from '@/api/mockData.js';

let fake;
vi.mock('@/api/supabaseClient.js', () => ({
  get supabase() { return fake; },
  SUPABASE_URL: 'https://fake.supabase.co',
}));

const PAPEIS = ['Cliente', 'Gestor', 'Suporte', 'Administrador'];
const seed = (papel) => ({
  organizations: [{ id: 'org-1', nome: 'Loja Teste', plan_id: 'pl-1', created_at: '2026-01-01T00:00:00Z' }],
  plans: [{ id: 'pl-1', nome: 'Starter', preco_mensal: 97 }],
  profiles: [{ id: 'p-1', auth_id: 'auth-1', nome: 'Pessoa Teste', email: 't@t.com', tipo_user_geral: papel, organization_id: papel === 'Cliente' ? 'org-1' : null, status_user: 'Ativo', created_at: '2026-01-01T00:00:00Z' }],
});

beforeEach(() => { cleanup(); sessionStorage.clear(); vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe.each(PAPEIS)('papel %s', (papel) => {
  it('abre todas as telas permitidas sem erro de render', async () => {
    fake = makeFakeSupabase(seed(papel));
    const { KoblyStoreProvider } = await import('@/store/store.jsx');
    const { Shell } = await import('@/shell/AppShell.jsx');
    render(<KoblyStoreProvider><Shell /></KoblyStoreProvider>);

    const nav = DB.roles[papel].nav;
    await screen.findAllByText(DB.NAV[nav[0]].label, {}, { timeout: 5000 });
    for (const id of nav) {
      const botoes = screen.getAllByRole('button', { name: new RegExp(`^${DB.NAV[id].label}`) });
      fireEvent.click(botoes[0]);
      // dá tempo da tela (lazy + consultas) montar
      await waitFor(() => expect(screen.queryByRole('status', { name: 'Carregando' })).toBeNull(), { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByText('Algo deu errado'), `tela ${id} (${papel}) caiu em erro`).toBeNull();
    }
  }, 60000);
});
