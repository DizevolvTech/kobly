import { describe, it, expect } from 'vitest';
import { KoblyMockDB as DB } from '@/api/mockData.js';

// Permissões por papel: protege contra um papel ganhar tela que não deveria ter.
const NAV_ESPERADA = {
  Cliente: ['painel', 'pipeline', 'campanhas', 'disparos', 'leads', 'integracoes', 'planos', 'chamados', 'ajuda', 'perfil'],
  Gestor: ['painel', 'clientes', 'pipeline', 'campanhas', 'disparos', 'leads', 'integracoes', 'relatorios', 'chamados', 'ajuda', 'perfil'],
  Suporte: ['chamados', 'leads', 'ajuda', 'perfil'],
  Administrador: ['painel', 'clientes', 'relatorios', 'planos', 'seguranca', 'chamados', 'perfil'],
};

describe('RBAC por papel', () => {
  it('cada papel enxerga exatamente as telas esperadas', () => {
    for (const [papel, nav] of Object.entries(NAV_ESPERADA)) {
      expect(DB.roles[papel].nav, papel).toEqual(nav);
    }
  });
  it('a home de cada papel está na própria navegação', () => {
    for (const [papel, def] of Object.entries(DB.roles)) {
      expect(def.nav, papel).toContain(def.home);
    }
  });
  it('toda rota da navegação tem item de menu e título', () => {
    for (const def of Object.values(DB.roles)) {
      for (const id of def.nav) {
        expect(DB.NAV[id], id).toBeTruthy();
        expect(DB.routeTitle[id], id).toBeTruthy();
      }
    }
  });
  it('só Administrador gerencia usuários/planos e só ele vê Segurança', () => {
    for (const [papel, def] of Object.entries(DB.roles)) {
      const admin = papel === 'Administrador';
      expect(!!def.can.manageUsers, papel).toBe(admin);
      expect(!!def.can.createPlan, papel).toBe(admin);
      expect(def.nav.includes('seguranca'), papel).toBe(admin);
    }
  });
  it('Cliente não vê telas multi-conta; Suporte não edita campanha', () => {
    expect(DB.roles.Cliente.nav).not.toContain('clientes');
    expect(DB.roles.Cliente.nav).not.toContain('relatorios');
    expect(DB.roles.Cliente.can.viewAllAccounts).toBe(false);
    expect(DB.roles.Suporte.can.editCampaign).toBe(false);
    expect(DB.roles.Suporte.nav).not.toContain('campanhas');
  });
});
