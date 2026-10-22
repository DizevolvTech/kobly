import React, { useState } from 'react';
import { Button, Input, Banner, Icon } from '@/ds';
import { useKobly } from '@/store/store.jsx';

// Kobly — tela de autenticação (login / cadastro / recuperação / nova senha).

function traduz(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('invalid login')) return 'E-mail ou senha incorretos.';
  if (m.includes('email not confirmed')) return 'Confirme seu e-mail antes de entrar.';
  if (m.includes('already registered') || m.includes('already been registered')) return 'Já existe uma conta com esse e-mail.';
  if (m.includes('rate limit') || m.includes('too many')) return 'Muitas tentativas. Aguarde um momento e tente de novo.';
  if (m.includes('password') && m.includes('6')) return 'A senha deve ter ao menos 8 caracteres.';
  return msg || 'Algo deu errado. Tente novamente.';
}

// Borda superior de 2px em gradiente accent — a "brasa quente" no topo do card.
// Cantos arredondados próprios (em vez de overflow:hidden no card) para não cortar
// o glow de hover do botão primário.
const cardTopEdge = {
  position: 'absolute', insetInlineStart: 0, insetInlineEnd: 0, top: 0, height: 2,
  background: 'var(--grad-accent)',
  borderTopLeftRadius: 'var(--radius-lg)', borderTopRightRadius: 'var(--radius-lg)',
};

// Campo de senha: reusa o Input do DS e adiciona um toggle "Mostrar/Ocultar"
// discreto na linha do rótulo. O Input não expõe slot à direita, então o toggle
// vive no cabeçalho do campo — nunca sobrepõe o texto digitado.
function PasswordField({ label, id, value, onChange, autoComplete, placeholder }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label htmlFor={id} style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-body)' }}>{label}</label>
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-pressed={show}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-subtle)', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-xs)', fontWeight: 'var(--fw-medium)' }}
        >
          <Icon name={show ? 'eye-off' : 'eye'} size={14} />
          {show ? 'Ocultar' : 'Mostrar'}
        </button>
      </div>
      <Input id={id} icon="lock" type={show ? 'text' : 'password'} value={value} onChange={onChange} placeholder={placeholder} autoComplete={autoComplete} />
    </div>
  );
}

export function KoblyAuthScreen({ mode = 'login' }) {
  const store = useKobly();
  const [form, setForm] = useState(mode === 'recovery' ? 'recovery' : 'login'); // login | signup | reset | recovery
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [nome, setNome] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');

  const clear = () => { setErr(''); setInfo(''); };
  const go = (f) => { clear(); setPassword(''); setPassword2(''); setForm(f); };

  async function doLogin(e) {
    e.preventDefault(); clear(); setBusy(true);
    const { error } = await store.signIn(email, password);
    setBusy(false);
    if (error) setErr(traduz(error)); // sucesso → o store troca pra fase 'app'
  }
  async function doSignup(e) {
    e.preventDefault(); clear();
    if (password.length < 8) return setErr('A senha deve ter ao menos 8 caracteres.');
    setBusy(true);
    const { error, needsConfirmation } = await store.signUp(email, password, nome);
    setBusy(false);
    if (error) return setErr(traduz(error));
    if (needsConfirmation) { go('login'); setInfo('Conta criada! Confirme seu e-mail para poder entrar.'); }
  }
  async function doReset(e) {
    e.preventDefault(); clear(); setBusy(true);
    const { error } = await store.resetPassword(email);
    setBusy(false);
    if (error) setErr(traduz(error));
    else setInfo('Se houver uma conta com esse e-mail, enviamos um link de redefinição.');
  }
  async function doRecovery(e) {
    e.preventDefault(); clear();
    if (password.length < 8) return setErr('A senha deve ter ao menos 8 caracteres.');
    if (password !== password2) return setErr('As senhas não conferem.');
    setBusy(true);
    const { error } = await store.updatePassword(password);
    setBusy(false);
    if (error) setErr(traduz(error));
    else store.notify('success', 'Senha atualizada! Você já está conectado.'); // sessão de recovery → store hidrata
  }

  const titles = {
    login: ['Entrar', 'Acesse o console da KOBLY.'],
    signup: ['Criar conta', 'Comece a recuperar vendas por e-mail.'],
    reset: ['Recuperar senha', 'Enviaremos um link para redefinir sua senha.'],
    recovery: ['Definir nova senha', 'Escolha uma nova senha para sua conta.'],
  };
  const [title, subtitle] = titles[form] || titles.login;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--grad-hero), var(--surface-app)', padding: 24, fontFamily: 'var(--font-sans)' }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        {/* Lockup oficial no lugar de mark + wordmark em texto: o letreiro do arquivo
            e' o desenho da marca, nao a fonte da UI. */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 22, justifyContent: 'center' }}>
          <img src="/assets/kobly-logo.png" alt="KOBLY" style={{ display: 'block', height: 34, width: 'auto' }} />
        </div>

        <div style={{ position: 'relative', background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)', padding: 28 }}>
          <span aria-hidden style={cardTopEdge} />

          <div key={form} style={{ animation: 'kbly-fade var(--dur-med) ease both' }}>
            <h1 style={{ margin: 0, fontSize: 'var(--text-2xl)', fontWeight: 'var(--fw-bold)', color: 'var(--text-strong)', letterSpacing: 'var(--ls-tight)' }}>{title}</h1>
            <p style={{ margin: '6px 0 20px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{subtitle}</p>

            {info && <Banner tone="success" style={{ marginBottom: 14 }}>{info}</Banner>}
            {err && <Banner tone="danger" style={{ marginBottom: 14 }}>{err}</Banner>}

            {form === 'login' && (
              <form onSubmit={doLogin} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Input label="E-mail" icon="mail" type="email" autoComplete="email" placeholder="voce@empresa.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <PasswordField label="Senha" id="kbly-login-senha" autoComplete="current-password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -6 }}>
                  <button type="button" onClick={() => go('reset')} style={linkBtn}>Esqueci minha senha</button>
                </div>
                <Button type="submit" variant="primary" loading={busy} disabled={!email || !password} iconLeft="log-in" style={{ width: '100%', justifyContent: 'center' }}>{busy ? 'Entrando…' : 'Entrar'}</Button>
                <div style={{ textAlign: 'center', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                  Não tem conta? <button type="button" onClick={() => go('signup')} style={linkBtn}>Criar conta</button>
                </div>
              </form>
            )}

            {form === 'signup' && (
              <form onSubmit={doSignup} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Input label="Nome" icon="user" type="text" autoComplete="name" placeholder="Seu nome" value={nome} onChange={(e) => setNome(e.target.value)} />
                <Input label="E-mail" icon="mail" type="email" autoComplete="email" placeholder="voce@empresa.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <PasswordField label="Senha" id="kbly-signup-senha" autoComplete="new-password" placeholder="mín. 8 caracteres" value={password} onChange={(e) => setPassword(e.target.value)} />
                <Button type="submit" variant="primary" loading={busy} disabled={!email || !password} iconLeft="user-plus" style={{ width: '100%', justifyContent: 'center' }}>{busy ? 'Criando…' : 'Criar conta'}</Button>
                <div style={{ textAlign: 'center', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                  Já tem conta? <button type="button" onClick={() => go('login')} style={linkBtn}>Entrar</button>
                </div>
              </form>
            )}

            {form === 'reset' && (
              <form onSubmit={doReset} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Input label="E-mail" icon="mail" type="email" autoComplete="email" placeholder="voce@empresa.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <Button type="submit" variant="primary" loading={busy} disabled={!email} iconLeft="mail" style={{ width: '100%', justifyContent: 'center' }}>{busy ? 'Enviando…' : 'Enviar link'}</Button>
                <div style={{ textAlign: 'center', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                  <button type="button" onClick={() => go('login')} style={linkBtn}>Voltar ao login</button>
                </div>
              </form>
            )}

            {form === 'recovery' && (
              <form onSubmit={doRecovery} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <PasswordField label="Nova senha" id="kbly-recovery-senha" autoComplete="new-password" placeholder="mín. 8 caracteres" value={password} onChange={(e) => setPassword(e.target.value)} />
                <PasswordField label="Confirmar nova senha" id="kbly-recovery-senha2" autoComplete="new-password" placeholder="repita a senha" value={password2} onChange={(e) => setPassword2(e.target.value)} />
                <Button type="submit" variant="primary" loading={busy} disabled={!password} iconLeft="check" style={{ width: '100%', justifyContent: 'center' }}>{busy ? 'Salvando…' : 'Salvar nova senha'}</Button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const linkBtn = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent)',
  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-semibold)',
};
