import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { KoblyMockDB } from '@/api/mockData.js';
import { KoblyApi } from '@/api/mockApi.js';
import { supabase } from '@/api/supabaseClient.js';
import { KoblyAuthScreen } from '@/shell/Login.jsx';
import { KoblyOnboarding } from '@/shell/Onboarding.jsx';

// Kobly — store global + AUTENTICAÇÃO REAL (Supabase Auth).
// Fases: loading → login → app (e recovery quando o usuário chega pelo link de
// redefinição de senha). A sessão é derivada do profile autenticado; a RLS faz o
// isolamento. O seletor de persona do topbar só aparece em DEV (atalho de demo);
// em produção, troca-se de conta via logout + login.
const Ctx = createContext(null);
const IS_DEV = !!import.meta.env.DEV;

function LoadingScreen({ label }) {
  return React.createElement(
    'div',
    { style: { height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, background: 'var(--surface-app)', color: 'var(--text-muted)', fontFamily: 'var(--font-sans)' } },
    React.createElement('img', { src: '/assets/kobly-mark.png', alt: 'KOBLY', width: 42, height: 42, style: { opacity: 0.92 } }),
    React.createElement('div', { style: { fontSize: 'var(--text-sm)', letterSpacing: 'var(--ls-tight)' } }, label || 'Carregando…'),
  );
}

function KoblyStoreProvider({ children }) {
  const DB = KoblyMockDB;
  const [phase, setPhase] = useState('loading'); // loading | login | recovery | onboarding | app
  const [role, setRoleState] = useState(null);
  const [session, setSession] = useState(null);
  // UX-1: view persistida em sessionStorage — sobrevive a troca de aba, reload e
  // reautenticação (token refresh dispara onAuthStateChange que antes resetava tudo).
  const [view, setView] = useState(() => {
    try { return sessionStorage.getItem('kbly_view') || null; } catch (_) { return null; }
  });
  const [authBusy, setAuthBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [ticketPrefill, setTicketPrefill] = useState(null);
  const toastTimer = useRef(null);
  // Ref: já inicializou a sessão uma vez? Evita re-hidratações (token refresh,
  // retorno de aba) sobrescreverem a navegação atual do usuário.
  const didInit = useRef(false);

  const fireToast = useCallback((tone, msg) => {
    clearTimeout(toastTimer.current);
    setToast({ tone, msg, key: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  }, []);

  const hydrate = useCallback(async () => {
    // Auditoria E2E (Frontend ALTO): sem try/catch, uma falha de loadAppSession
    // (rede/RLS/Supabase fora) deixava phase preso em 'loading' → spinner eterno
    // sem recuperação. Agora, falha no boot cai para 'login' (com aviso).
    let s;
    try {
      s = await KoblyApi.loadAppSession();
    } catch (e) {
      didInit.current = false;
      setPhase('login');
      fireToast('warn', 'Não foi possível carregar sua sessão. Tente entrar novamente.');
      return;
    }
    if (s) {
      setSession(s);
      setRoleState(s.role);
      if (s.role === 'Cliente' && !s.empresaId) { setPhase('onboarding'); return; }
      // UX-1: SÓ define a tela inicial na PRIMEIRA hidratação. Re-hidratações
      // (token refresh ao voltar de outra aba) preservam onde o usuário estava.
      if (!didInit.current) {
        // Recarregar a página (ou o navegador descartar a aba) volta para a tela onde a pessoa estava,
        // desde que o perfil ainda tenha acesso a ela; senão, início do perfil.
        const def = DB.roles[s.role] || DB.roles.Cliente;
        let saved = null; try { saved = sessionStorage.getItem('kbly_view'); } catch (_) { /* noop */ }
        setView(saved && def.nav.includes(saved) ? saved : def.home);
      }
      didInit.current = true;
      setPhase('app');
    } else {
      didInit.current = false;
      setPhase('login');
    }
  }, [DB, fireToast]);

  // Onboarding: cria a org própria e re-hidrata (a sessão nova já vem com empresaId).
  const completeOnboarding = useCallback(async ({ nome, segmento, nichos }) => {
    const r = await KoblyApi.createOwnOrg({ nome, segmento });
    if (r.error) return r;
    if (nichos && nichos.length) { try { await KoblyApi.saveCuradoria(nichos); } catch (e) { /* opcional */ } }
    await hydrate();
    return r;
  }, [hydrate]);

  useEffect(() => {
    // onAuthStateChange dispara INITIAL_SESSION na montagem (sessão restaurada ou null),
    // além de SIGNED_IN / SIGNED_OUT / PASSWORD_RECOVERY / TOKEN_REFRESHED.
    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      // Garante que o Realtime avalie as RLS (WALRUS) com o JWT atual — inclusive
      // após TOKEN_REFRESHED; sem isso a subscription pode ficar com token vencido.
      try { supabase.realtime.setAuth(sess ? sess.access_token : null); } catch (e) { /* noop */ }
      if (event === 'EMAIL_CONFIRMED') { fireToast('success', 'E-mail confirmado! Agora é só entrar com a sua senha.'); setPhase('login'); return; }
      if (event === 'EMAIL_CONFIRM_FAILED') { fireToast('danger', 'Este link de confirmação é inválido ou expirou. Cadastre-se de novo ou peça outro link.'); setPhase('login'); return; }
      if (event === 'PASSWORD_RECOVERY') { setPhase('recovery'); return; }
      if (event === 'SIGNED_OUT' || !sess) {
        setSession(null); setRoleState(null); setView(null); setPhase('login'); setAuthBusy(false);
        return;
      }
      if (event === 'TOKEN_REFRESHED') return; // sessão já hidratada; só o token mudou
      hydrate().finally(() => setAuthBusy(false));
    });
    return () => { try { sub.subscription.unsubscribe(); } catch (e) { /* noop */ } };
  }, [hydrate]);

  // UX-1: confirma antes de trocar de rota se há edição de fluxo não salva. Retorna
  // true se navegou (o AppShell usa o retorno p/ só fechar o overlay mobile em caso
  // de sucesso). O FlowBuilder registra/desregistra o estado "editando" via setEditing.
  const [editing, setEditingState] = useState(null); // { campaignId, dirty }
  const setEditing = useCallback((e) => setEditingState(e), []);
  const clearEditing = useCallback(() => setEditingState(null), []);
  const navigate = useCallback((v) => {
    if (editing && editing.dirty) {
      const leave = window.confirm('Você tem alterações não salvas. O rascunho fica salvo e será recuperado quando voltar. Trocar de tela?');
      if (!leave) return false;
    }
    setView(v);
    try { sessionStorage.setItem('kbly_view', v); } catch (_) { /* noop */ }
    return true;
  }, [editing]);

  // Troca de papel = atalho de demo (login na persona). Só exposto em DEV.
  const setRole = useCallback((rk) => {
    if (!IS_DEV || !DB.roles[rk]) return;
    setAuthBusy(true);
    KoblyApi.signInAsRole(rk).then((r) => {
      if (r && r.error) { setAuthBusy(false); fireToast('danger', 'Não foi possível entrar como ' + rk); }
    });
  }, [DB, fireToast]);

  const value = {
    phase, isDev: IS_DEV, authBusy,
    role, roleDef: role ? DB.roles[role] : null, can: role ? DB.roles[role].can : {},
    setRole, view, navigate, session, editing, setEditing, clearEditing,
    // ações de autenticação (usadas pela tela de login e pelo perfil/topbar)
    signIn: (email, pw) => KoblyApi.signIn(email, pw),
    signInAsRole: (rk) => KoblyApi.signInAsRole(rk),
    signUp: (email, pw, nome) => KoblyApi.signUp(email, pw, nome),
    resetPassword: (email) => KoblyApi.resetPassword(email),
    updatePassword: (pw) => KoblyApi.updatePassword(pw),
    signOut: () => { try { sessionStorage.removeItem('kbly_view'); } catch (_) {} KoblyApi.signOut(); },
    completeOnboarding,
    ticketPrefill, setTicketPrefill,
    toast, notify: fireToast, dismissToast: () => setToast(null),
  };

  let content;
  if (phase === 'loading') content = React.createElement(LoadingScreen, { label: 'Carregando…' });
  else if (phase === 'login') content = React.createElement(KoblyAuthScreen, { mode: 'login' });
  else if (phase === 'recovery') content = React.createElement(KoblyAuthScreen, { mode: 'recovery' });
  else if (phase === 'onboarding') content = React.createElement(KoblyOnboarding);
  else content = children;

  return React.createElement(Ctx.Provider, { value }, content);
}

function useKobly() { return useContext(Ctx); }
export { KoblyStoreProvider, useKobly };
