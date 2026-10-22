import { describe, it, expect } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAsync } from '@/lib/hooks.jsx';

describe('useAsync', () => {
  it('primeira carga mostra loading; depois ready com os dados', async () => {
    const { result } = renderHook(() => useAsync(async () => 'a', []));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data).toBe('a');
  });
  it('reload (ex.: depois de Salvar) NÃO volta para loading: a tela fica como está até chegar o dado novo', async () => {
    let n = 0; let release;
    const { result } = renderHook(() => useAsync(() => (n++ === 0 ? Promise.resolve('v1') : new Promise((r) => { release = r; })), []));
    await waitFor(() => expect(result.current.data).toBe('v1'));
    const seen = [];
    act(() => { result.current.reload(); });
    seen.push(result.current.status, result.current.data);
    expect(seen).toEqual(['ready', 'v1']);
    await act(async () => { release('v2'); });
    await waitFor(() => expect(result.current.data).toBe('v2'));
    expect(result.current.status).toBe('ready');
  });
  it('mudar a dependência (outra conta) volta a carregar do zero', async () => {
    const { result, rerender } = renderHook(({ id }) => useAsync(async () => id, [id]), { initialProps: { id: 1 } });
    await waitFor(() => expect(result.current.data).toBe(1));
    rerender({ id: 2 });
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.data).toBe(2));
  });
  it('falha ao recarregar com dado na tela mantém o dado; falha na primeira carga mostra erro e permite tentar de novo', async () => {
    let fail = false;
    const { result } = renderHook(() => useAsync(async () => { if (fail) throw new Error('caiu'); return 'ok'; }, []));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    fail = true; act(() => { result.current.reload(); });
    await waitFor(() => expect(result.current.data).toBe('ok')); expect(result.current.status).toBe('ready');
    const f2 = renderHook(() => useAsync(async () => { throw new Error('caiu de cara'); }, []));
    await waitFor(() => expect(f2.result.current.status).toBe('error'));
    expect(f2.result.current.error).toBe('caiu de cara');
  });
});
