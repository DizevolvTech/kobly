// Rascunho de edição (e-mail, WhatsApp, SMS): guarda o que a pessoa digitou no navegador a cada pausa
// e ao sair da aba, para sobreviver a trocar de aba, recarregar a página ou perder a sessão.
// Só existe enquanto houver diferença para o que está salvo; sair confirmando "descartar" ou salvar apaga.
import { useEffect, useRef } from 'react';

const PREFIX = 'kobly:editdraft:';
export const draftKey = (kind, id, scope = '') => `${PREFIX}${kind}:${id || 'novo'}:${scope}`;
export function readDraft(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function clearDraft(key) { try { localStorage.removeItem(key); } catch { /* sem armazenamento */ } }
function writeDraft(key, values) { try { localStorage.setItem(key, JSON.stringify({ values, savedAt: Date.now() })); } catch { /* cheio/privado */ } }

// values/baseline: objetos simples comparáveis. Grava com pequena pausa e na hora ao esconder a aba.
export function useDraftAutosave(key, values, baseline) {
  const latest = useRef({ key, values, baseline });
  latest.current = { key, values, baseline };
  const sync = () => {
    const { key: k, values: v, baseline: b } = latest.current;
    if (JSON.stringify(v) === JSON.stringify(b)) clearDraft(k); else writeDraft(k, v);
  };
  const sig = JSON.stringify(values);
  useEffect(() => { const t = setTimeout(sync, 250); return () => clearTimeout(t); }, [key, sig]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') sync(); };
    window.addEventListener('pagehide', sync); document.addEventListener('visibilitychange', onHide);
    return () => { window.removeEventListener('pagehide', sync); document.removeEventListener('visibilitychange', onHide); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
