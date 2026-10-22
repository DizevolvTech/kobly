import { Component } from 'react';

// Kobly — ErrorBoundary em dois níveis:
// - `variant="app"` (main.jsx): fallback full-screen com recarregar — última linha de defesa.
// - `variant="screen"` (AppShell, com key={rota}): um crash de tela não derruba nav/topbar;
//   o remount ao navegar reseta o boundary sozinho.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Sem telemetria por enquanto — o log local ajuda no suporte.
    console.error('[KOBLY] erro de render:', error, info && info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { variant = 'screen', onHome } = this.props;
    const box = {
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      textAlign: 'center', gap: 16, padding: '56px 32px',
    };
    const btn = (primary) => ({
      padding: '10px 18px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
      fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-semibold)', fontFamily: 'inherit',
      border: primary ? 'none' : '1px solid var(--border-default)',
      background: primary ? 'var(--primary-bg)' : 'transparent',
      color: primary ? 'var(--primary-fg)' : 'var(--text-body)',
    });
    const title = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 420 }}>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: 'var(--fw-bold)', color: 'var(--text-strong)' }}>Algo deu errado</div>
        <div style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)', lineHeight: 'var(--lh-normal)' }}>
          Encontramos um erro inesperado{variant === 'screen' ? ' nesta tela' : ''}. Você pode tentar novamente — se persistir, fale com o suporte.
        </div>
      </div>
    );

    if (variant === 'app') {
      return (
        <div style={{ ...box, minHeight: '100dvh', background: 'var(--surface-app, #000)' }}>
          <img src="/assets/kobly-mark.png" alt="KOBLY" style={{ width: 44, height: 44, opacity: 0.9 }} />
          {title}
          <button style={btn(true)} onClick={() => window.location.reload()}>Recarregar</button>
        </div>
      );
    }

    return (
      <div style={{ ...box, background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)' }}>
        {title}
        <div style={{ display: 'flex', gap: 10 }}>
          <button style={btn(true)} onClick={this.reset}>Tentar novamente</button>
          {onHome && <button style={btn(false)} onClick={() => { this.reset(); onHome(); }}>Ir para o início</button>}
        </div>
      </div>
    );
  }
}

export { ErrorBoundary };
