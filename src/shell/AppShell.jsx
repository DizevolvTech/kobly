// Kobly — application shell: NavRail + Topbar + rota ativa (com ErrorBoundary por rota),
// SupportProvider (conversas + Realtime) e SupportWidget (FAB de suporte IA/humano).
// Responsivo: rail completo no desktop → colapsado (72px) no tablet (≤1024) →
// oculto no mobile (≤768), onde vira um overlay aberto pelo hambúrguer do Topbar.
import React, { useState, useEffect, lazy, Suspense } from 'react';
import { NavRail, IconButton } from '@/ds';
import { Toast } from '@/lib/ui.jsx';
import { Reveal } from '@/lib/motion.jsx';
import { useBreakpoint } from '@/lib/responsive.jsx';
import { useKobly } from '@/store/store.jsx';
import { KoblyMockDB } from '@/api/mockData.js';
import { KoblyTopbar } from '@/shell/Topbar.jsx';
import { ErrorBoundary } from '@/shell/ErrorBoundary.jsx';
import { SupportProvider, useSupport } from '@/shell/SupportProvider.jsx';
import { SupportWidget } from '@/shell/SupportWidget.jsx';

// Telas carregadas sob demanda: o primeiro carregamento baixa só o shell + a tela aberta.
const screen = (load, name) => lazy(() => load().then((m) => ({ default: m[name] })));
const KoblyDashboard = screen(() => import('@/routes/Dashboard.jsx'), 'KoblyDashboard');
const KoblyPipeline = screen(() => import('@/routes/Pipeline.jsx'), 'KoblyPipeline');
const KoblyCampaigns = screen(() => import('@/routes/Campaigns.jsx'), 'KoblyCampaigns');
const KoblyBulkSend = screen(() => import('@/routes/BulkSend.jsx'), 'KoblyBulkSend');
const KoblyLeads = screen(() => import('@/routes/Leads.jsx'), 'KoblyLeads');
const KoblyIntegrations = screen(() => import('@/routes/Integrations.jsx'), 'KoblyIntegrations');
const KoblyProfile = screen(() => import('@/routes/Profile.jsx'), 'KoblyProfile');
const KoblyClients = screen(() => import('@/routes/Clients.jsx'), 'KoblyClients');
const KoblyReports = screen(() => import('@/routes/Reports.jsx'), 'KoblyReports');
const KoblyPlans = screen(() => import('@/routes/Plans.jsx'), 'KoblyPlans');
const KoblySecurity = screen(() => import('@/routes/Security.jsx'), 'KoblySecurity');
const KoblyTickets = screen(() => import('@/routes/Tickets.jsx'), 'KoblyTickets');
const KoblyHelp = screen(() => import('@/routes/Help.jsx'), 'KoblyHelp');

// Route id -> screen component (FlowBuilder / EmailEditor are sub-screens of Campanhas).
const SCREENS = {
  painel: KoblyDashboard,
  clientes: KoblyClients,
  pipeline: KoblyPipeline,
  campanhas: KoblyCampaigns,
  disparos: KoblyBulkSend,
  leads: KoblyLeads,
  integracoes: KoblyIntegrations,
  relatorios: KoblyReports,
  planos: KoblyPlans,
  seguranca: KoblySecurity,
  chamados: KoblyTickets,
  ajuda: KoblyHelp,
  perfil: KoblyProfile,
};

function ScreenFallback() {
  return <div role="status" aria-label="Carregando" style={{ minHeight: 240 }} />;
}

function ShellInner() {
  const store = useKobly();
  const support = useSupport();
  const { isTablet, isMobile } = useBreakpoint();
  const [mobileNav, setMobileNav] = useState(false);
  const DB = KoblyMockDB;

  // Fecha o overlay ao sair do mobile (evita reabrir “fantasma” ao voltar).
  useEffect(() => { if (!isMobile && mobileNav) setMobileNav(false); }, [isMobile, mobileNav]);

  const role = store.roleDef;
  const view = store.view;
  // Ensure the current route is allowed for the role; otherwise fall back to home.
  const allowed = role.nav.includes(view) ? view : role.home;
  // Badge de não-lidas no item "Chamados" (fonte: SupportProvider/Realtime).
  const navItems = role.nav.map((id) => (
    id === 'chamados' && support && support.unreadTotal > 0
      ? { ...DB.NAV[id], badge: support.unreadTotal }
      : DB.NAV[id]
  ));
  const Screen = SCREENS[allowed];
  const title = DB.routeTitle[allowed] || '';
  const eyebrow = `${store.role} · ${store.session.contextLabel}`;

  // Navegar sempre fecha o overlay mobile.
  // UX-1: só fecha o overlay e navega de fato se não houver edição pendente (o
  // navigate confirma com o usuário antes de descartar alterações não salvas).
  const go = (id) => { if (store.navigate(id)) setMobileNav(false); };

  const railProps = {
    items: navItems,
    active: allowed,
    onNavigate: go,
    markSrc: '/assets/kobly-mark.svg',
    logoSrc: '/assets/kobly-logo.svg',
    workspaceName: store.session.contextLabel,
    workspaceMeta: store.session.plano ? `Plano ${store.session.plano}` : store.roleDef.label,
  };

  return (
    <div style={{ display: 'flex', height: '100dvh', overflow: 'hidden', background: 'var(--surface-app)' }}>
      {/* Rail persistente: some no mobile; colapsa (72px) no tablet. */}
      {!isMobile && <NavRail {...railProps} collapsed={isTablet} />}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <KoblyTopbar eyebrow={eyebrow} title={title} onMenu={isMobile ? () => setMobileNav(true) : undefined} />
        <main style={{ flex: 1, overflowY: 'auto', padding: 'var(--content-pad)' }}>
          <Reveal key={allowed + store.role} y={6} style={{ maxWidth: 'var(--content-max)', margin: '0 auto' }}>
            {/* Boundary por rota: crash de tela não derruba nav/topbar; o key reseta ao navegar. */}
            <ErrorBoundary key={allowed} variant="screen" onHome={() => go(role.home)}>
              <Suspense fallback={<ScreenFallback />}>{Screen ? <Screen /> : null}</Suspense>
            </ErrorBoundary>
          </Reveal>
        </main>
      </div>

      {/* Overlay de navegação no mobile: backdrop + rail completo (largura própria). */}
      {isMobile && mobileNav && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 90, display: 'flex' }}>
          <div
            onClick={() => setMobileNav(false)}
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', animation: 'kbly-fade var(--dur-fast) ease both' }}
          />
          <div style={{ position: 'relative', height: '100%', boxShadow: 'var(--shadow-pop)', animation: 'kbly-slide-in var(--dur-med) var(--ease-out) both' }}>
            <NavRail {...railProps} style={{ width: 264 }} />
            <IconButton
              icon="x"
              variant="secondary"
              aria-label="Fechar menu"
              onClick={() => setMobileNav(false)}
              style={{ position: 'absolute', top: 16, insetInlineEnd: -18, background: 'var(--surface-overlay)' }}
            />
          </div>
        </div>
      )}

      <SupportWidget />
      {store.toast && (
        <Toast key={store.toast.key} tone={store.toast.tone} onClose={store.dismissToast}>
          {store.toast.msg}
        </Toast>
      )}
    </div>
  );
}

export function Shell() {
  return (
    <SupportProvider>
      <ShellInner />
    </SupportProvider>
  );
}

export default Shell;
