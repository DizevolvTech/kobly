import { useState, useEffect, useCallback, useRef } from 'react';

// Kobly — hooks e primitivos de layout compartilhados pelas rotas.
// useAsync, PageIntro, Field, window.Money, window.Pct, Cluster

// Carrega dados async com estados loading/error/ready. deps re-dispara.
function useAsync(fn, deps) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const fnRef = useRef(fn); fnRef.current = fn;
  // `background`: recarrega mantendo o que já está na tela (status continua 'ready'). Sem isso, todo "Salvar"
  // que chama reload() trocava a página por um esqueleto vazio: a tela encolhia, o scroll pulava e o que
  // estava aberto na página (abas, formulários) desmontava — parecia que não tinha salvo.
  const run = useCallback((background = false) => {
    let alive = true;
    setState((s) => (background === true && s.status === 'ready' ? s : { ...s, status: 'loading', error: null }));
    Promise.resolve(fnRef.current())
      .then((data) => { if (alive) setState({ status: 'ready', data, error: null }); })
      .catch((err) => { if (alive) setState((s) => (background === true && s.data ? { ...s, status: 'ready' } : { status: 'error', data: null, error: err.message || 'Erro inesperado.' })); });
    return () => { alive = false; };
  }, deps || []);
  useEffect(() => run(), deps || []);
  const reload = useCallback(() => { run(true); }, [run]);
  return { ...state, reload, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

// Subtítulo introdutório da página (abaixo do topbar).
function PageIntro({ children, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 22 }}>
      <p style={{ margin: 0, fontSize: 'var(--text-md)', color: 'var(--text-muted)', maxWidth: 720, lineHeight: 'var(--lh-normal)' }}>{children}</p>
      {action}
    </div>
  );
}

// Linha rótulo→valor para painéis de detalhe.
function Field({ label, children, mono = false }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: 'var(--ls-wide)', fontWeight: 'var(--fw-semibold)' }}>{label}</span>
      <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-strong)', fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)', wordBreak: 'break-word' }}>{children}</span>
    </div>
  );
}

function Cluster({ children, gap = 10, style = {} }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap, flexWrap: 'wrap', ...style }}>{children}</div>;
}

export { useAsync, PageIntro, Field, Cluster };
