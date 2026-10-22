import { describe, it, expect, vi } from 'vitest';
import { createApiClient } from '@/api/apiClient.js';

const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const json = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function mk(handler, extra = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init = {}) => { calls.push({ url, init }); return handler(url, init, calls); });
  const storage = extra.storage || memStore();
  const client = createApiClient({ baseUrl: 'http://api.test', fetchImpl, storage, ...extra });
  return { client, calls, fetchImpl, storage };
}
const SESS = (over = {}) => ({ access_token: 'AT', refresh_token: 'RT', expires_at: 4_000_000_000, user: { id: 'u1', email: 'a@b.test' }, ...over });

describe('consultas (from)', () => {
  it('monta select/filtros/ordem/limite no formato PostgREST', async () => {
    const { client, calls } = mk(() => json([]));
    await client.from('leads').select('id, nome').eq('organization_id', 'o1').in('status', ['a', 'b c']).gte('valor', 10).order('created_at', { ascending: false }).limit(5);
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe('/rest/v1/leads');
    expect(u.searchParams.get('select')).toBe('id,nome');
    expect(u.searchParams.get('organization_id')).toBe('eq.o1');
    expect(u.searchParams.get('status')).toBe('in.(a,"b c")');
    expect(u.searchParams.get('valor')).toBe('gte.10');
    expect(u.searchParams.get('order')).toBe('created_at.desc');
    expect(u.searchParams.get('limit')).toBe('5');
  });
  it('várias ordenações viram uma lista e is.null funciona', async () => {
    const { client, calls } = mk(() => json([]));
    await client.from('t').select('*').order('a').order('b', { ascending: false }).is('c', null);
    const u = new URL(calls[0].url);
    expect(u.searchParams.get('order')).toBe('a.asc,b.desc');
    expect(u.searchParams.get('c')).toBe('is.null');
  });
  it('insert sem select não pede retorno; com select pede representação', async () => {
    const { client, calls } = mk((u, i) => (i.headers.Prefer?.includes('representation') ? json([{ id: 1 }], 201) : new Response(null, { status: 201 })));
    const a = await client.from('t').insert({ x: 1 });
    expect(a.error).toBeNull(); expect(a.data).toBeNull();
    expect(calls[0].init.method).toBe('POST'); expect(calls[0].init.headers.Prefer).toContain('return=minimal');
    const b = await client.from('t').insert({ x: 1 }).select().single();
    expect(b.data).toEqual([{ id: 1 }]);
    expect(calls[1].init.headers.Prefer).toContain('return=representation');
    expect(calls[1].init.headers.Accept).toBe('application/vnd.pgrst.object+json');
  });
  it('update e delete usam PATCH/DELETE com filtro', async () => {
    const { client, calls } = mk(() => new Response(null, { status: 204 }));
    expect((await client.from('t').update({ a: 1 }).eq('id', 'x')).error).toBeNull();
    expect((await client.from('t').delete().eq('id', 'x')).error).toBeNull();
    expect(calls.map((c) => c.init.method)).toEqual(['PATCH', 'DELETE']);
    expect(new URL(calls[0].url).searchParams.get('id')).toBe('eq.x');
  });
  it('upsert pede merge-duplicates com on_conflict', async () => {
    const { client, calls } = mk(() => new Response(null, { status: 201 }));
    await client.from('t').upsert({ a: 1 }, { onConflict: 'a' });
    expect(calls[0].init.headers.Prefer).toContain('resolution=merge-duplicates');
    expect(new URL(calls[0].url).searchParams.get('on_conflict')).toBe('a');
  });
  it('maybeSingle: 0 linhas → null; 2 linhas → erro; 1 → objeto', async () => {
    let rows = [];
    const { client } = mk(() => json(rows));
    expect((await client.from('t').select().maybeSingle()).data).toBeNull();
    rows = [{ id: 1 }]; expect((await client.from('t').select().maybeSingle()).data).toEqual({ id: 1 });
    rows = [{ id: 1 }, { id: 2 }]; expect((await client.from('t').select().maybeSingle()).error.code).toBe('PGRST116');
  });
  it('erro do servidor vira {error:{message,code}} sem lançar exceção; falha de rede também', async () => {
    const a = mk(() => json({ message: 'permission denied', code: '42501' }, 403));
    const r = await a.client.from('t').select();
    expect(r.data).toBeNull(); expect(r.error).toMatchObject({ message: 'permission denied', code: '42501' });
    const b = mk(() => { throw new Error('offline'); });
    expect((await b.client.from('t').select()).error.message).toBe('offline');
  });
  it('count exato lê o content-range', async () => {
    const { client, calls } = mk(() => json([], 200, { 'content-range': '0-0/42' }));
    const r = await client.from('t').select('id', { count: 'exact', head: true });
    expect(calls[0].init.method).toBe('HEAD'); expect(calls[0].init.headers.Prefer).toContain('count=exact');
    expect(r.count).toBe(42);
  });
});

describe('autenticação e sessão', () => {
  it('login guarda a sessão, avisa SIGNED_IN e manda o token nas consultas', async () => {
    const { client, calls, storage } = mk((u) => (u.endsWith('/auth/login') ? json(SESS()) : json([])));
    const events = [];
    client.auth.onAuthStateChange((e) => events.push(e));
    const r = await client.auth.signInWithPassword({ email: 'a@b.test', password: 'x' });
    expect(r.error).toBeNull();
    expect(events).toContain('SIGNED_IN');
    expect(JSON.parse(storage.getItem('kobly_auth_v1')).access_token).toBe('AT');
    await client.from('leads').select();
    expect(calls[1].init.headers.Authorization).toBe('Bearer AT');
  });
  it('login errado devolve a mensagem e não guarda sessão', async () => {
    const { client, storage } = mk(() => json({ message: 'Invalid login credentials' }, 400));
    const r = await client.auth.signInWithPassword({ email: 'a', password: 'b' });
    expect(r.error.message).toBe('Invalid login credentials'); expect(storage.getItem('kobly_auth_v1')).toBeNull();
  });
  it('restaura a sessão do armazenamento e emite INITIAL_SESSION', async () => {
    const storage = memStore(); storage.setItem('kobly_auth_v1', JSON.stringify(SESS()));
    const { client } = mk(() => json([]), { storage });
    const ev = await new Promise((res) => client.auth.onAuthStateChange((e, s) => res([e, s && s.access_token])));
    expect(ev).toEqual(['INITIAL_SESSION', 'AT']);
  });
  it('token perto de vencer é renovado antes da consulta', async () => {
    const storage = memStore(); storage.setItem('kobly_auth_v1', JSON.stringify(SESS({ expires_at: 100 })));
    const { client, calls } = mk((u) => (u.endsWith('/auth/refresh') ? json(SESS({ access_token: 'AT2', refresh_token: 'RT2' })) : json([])), { storage, now: () => 90 });
    await client.from('t').select();
    expect(calls[0].url).toMatch(/\/auth\/refresh$/);
    expect(JSON.parse(calls[0].init.body)).toEqual({ refresh_token: 'RT' });
    expect(calls[1].init.headers.Authorization).toBe('Bearer AT2');
  });
  it('401 do servidor renova uma vez e repete; refresh inválido derruba a sessão', async () => {
    const storage = memStore(); storage.setItem('kobly_auth_v1', JSON.stringify(SESS()));
    let first = true;
    const { client, calls } = mk((u) => {
      if (u.endsWith('/auth/refresh')) return json(SESS({ access_token: 'AT2' }));
      if (first) { first = false; return json({ message: 'JWT expired' }, 401); }
      return json([{ ok: 1 }]);
    }, { storage });
    const r = await client.from('t').select();
    expect(r.data).toEqual([{ ok: 1 }]);
    expect(calls.map((c) => c.url.split('/').pop().split('?')[0])).toEqual(['t', 'refresh', 't']);
    const bad = mk((u) => (u.endsWith('/auth/refresh') ? json({}, 401) : json({ message: 'JWT expired' }, 401)), { storage: (() => { const s = memStore(); s.setItem('kobly_auth_v1', JSON.stringify(SESS())); return s; })() });
    const events = []; bad.client.auth.onAuthStateChange((e) => events.push(e));
    await bad.client.from('t').select();
    expect(events).toContain('SIGNED_OUT');
  });
  it('refresh que falha por indisponibilidade (503/429) NÃO derruba a sessão de quem está editando', async () => {
    for (const st of [503, 429, 500]) {
      const storage = memStore(); storage.setItem('kobly_auth_v1', JSON.stringify(SESS()));
      const { client } = mk((u) => (u.endsWith('/auth/refresh') ? json({}, st) : json({ message: 'JWT expired' }, 401)), { storage });
      const events = []; client.auth.onAuthStateChange((e) => events.push(e));
      await client.from('t').select();
      expect(events).not.toContain('SIGNED_OUT');
      expect(storage.getItem('kobly_auth_v1')).toBeTruthy();
    }
  });
  it('duas abas: a que ficou com o refresh token velho adota a sessão da outra e NÃO é deslogada', async () => {
    const storage = memStore(); storage.setItem('kobly_auth_v1', JSON.stringify(SESS({ expires_at: 100 })));
    let used = new Set();
    const srv = (u, init) => {                                   // refresh de uso único, como o servidor real
      if (u.endsWith('/auth/refresh')) { const t = JSON.parse(init.body).refresh_token; if (used.has(t)) return json({}, 401); used.add(t); return json(SESS({ access_token: 'AT2', refresh_token: 'RT2', expires_at: 4_000_000_000 })); }
      return json([{ ok: 1 }]);
    };
    const A = mk(srv, { storage, now: () => 200 }); const B = mk(srv, { storage, now: () => 200 });
    const evB = []; B.client.auth.onAuthStateChange((e) => evB.push(e));
    await A.client.from('t').select();                          // aba A renova (RT -> RT2)
    const r = await B.client.from('t').select();                // aba B ainda tinha RT
    expect(r.data).toEqual([{ ok: 1 }]);
    expect(evB).not.toContain('SIGNED_OUT');
    expect(B.calls.some((c) => c.url.endsWith('/auth/refresh'))).toBe(false);   // nem precisou renovar de novo
    expect(JSON.parse(storage.getItem('kobly_auth_v1')).refresh_token).toBe('RT2');
  });
  it('corrida real: as duas abas tentam renovar ao mesmo tempo; a perdedora adota a sessão da vencedora', async () => {
    const storage = memStore(); storage.setItem('kobly_auth_v1', JSON.stringify(SESS({ expires_at: 100 })));
    const used = new Set();
    const srv = async (u, init) => {
      if (u.endsWith('/auth/refresh')) { await new Promise((r) => setTimeout(r, 5)); const t = JSON.parse(init.body).refresh_token; if (used.has(t)) return json({}, 401); used.add(t); return json(SESS({ access_token: 'AT2', refresh_token: 'RT2', expires_at: 4_000_000_000 })); }
      return json([{ ok: 1 }]);
    };
    const A = mk(srv, { storage, now: () => 200 }); const B = mk(srv, { storage, now: () => 200 });
    const evs = []; A.client.auth.onAuthStateChange((e) => evs.push(e)); B.client.auth.onAuthStateChange((e) => evs.push(e));
    const [ra, rb] = await Promise.all([A.client.from('t').select(), B.client.from('t').select()]);
    expect(ra.data).toEqual([{ ok: 1 }]); expect(rb.data).toEqual([{ ok: 1 }]);
    expect(evs).not.toContain('SIGNED_OUT');
  });
  it('401 com token velho: adota a sessão que outra aba gravou em vez de renovar de novo', async () => {
    const storage = memStore(); storage.setItem('kobly_auth_v1', JSON.stringify(SESS()));
    const srv = (u, init) => (u.endsWith('/auth/refresh') ? json({}, 500) : (init.headers.Authorization === 'Bearer AT2' ? json([{ ok: 2 }]) : json({ message: 'JWT expired' }, 401)));
    const B = mk(srv, { storage });
    storage.setItem('kobly_auth_v1', JSON.stringify(SESS({ access_token: 'AT2', refresh_token: 'RT2', expires_at: 4_100_000_000 })));   // outra aba renovou
    const r = await B.client.from('t').select();
    expect(r.data).toEqual([{ ok: 2 }]);
    expect(B.calls.filter((c) => c.url.endsWith('/auth/refresh')).length).toBe(0);
  });
  it('nunca volta para uma sessão MAIS VELHA gravada por outra aba', async () => {
    const storage = memStore(); storage.setItem('kobly_auth_v1', JSON.stringify(SESS({ access_token: 'NOVO', expires_at: 4_100_000_000 })));
    const B = mk((u) => json([{ ok: 1 }]), { storage });
    storage.setItem('kobly_auth_v1', JSON.stringify(SESS({ access_token: 'VELHO', refresh_token: 'RTV', expires_at: 3_000_000_000 })));
    window.dispatchEvent(new StorageEvent('storage', { key: 'kobly_auth_v1', newValue: storage.getItem('kobly_auth_v1') }));
    await B.client.from('t').select();
    expect(B.calls[0].init.headers.Authorization).toBe('Bearer NOVO');
  });
  it('sair em outra aba encerra a sessão aqui também', async () => {
    const storage = memStore(); storage.setItem('kobly_auth_v1', JSON.stringify(SESS()));
    const B = mk(() => json([]), { storage }); const ev = []; B.client.auth.onAuthStateChange((e) => ev.push(e));
    window.dispatchEvent(new StorageEvent('storage', { key: 'kobly_auth_v1', newValue: null }));
    expect(ev).toContain('SIGNED_OUT');
    expect((await B.client.auth.getSession()).data.session).toBeNull();
  });
  it('link de confirmação (#type=confirm): confirma no servidor, limpa o endereço e avisa; link ruim avisa falha', async () => {
    for (const [status, expected] of [[200, 'EMAIL_CONFIRMED'], [400, 'EMAIL_CONFIRM_FAILED']]) {
      window.history.replaceState(null, '', '/#type=confirm&token=TK%2F1');
      const { client, calls } = mk((u) => json({}, status));
      const ev = []; client.auth.onAuthStateChange((e) => ev.push(e));
      await new Promise((r) => setTimeout(r, 20));
      expect(calls[0].url).toMatch(/\/auth\/confirm$/); expect(JSON.parse(calls[0].init.body)).toEqual({ token: 'TK/1' });
      expect(ev).toContain(expected); expect(window.location.hash).toBe('');
    }
  });
  it('depois de renovar, a sessão nova fica guardada (o token velho não volta)', async () => {
    const storage = memStore(); storage.setItem('kobly_auth_v1', JSON.stringify(SESS({ expires_at: 100 })));
    const { client } = mk((u) => (u.endsWith('/auth/refresh') ? json(SESS({ access_token: 'AT2', refresh_token: 'RT2' })) : json([])), { storage, now: () => 90 });
    await client.from('t').select();
    expect(JSON.parse(storage.getItem('kobly_auth_v1'))).toMatchObject({ access_token: 'AT2', refresh_token: 'RT2' });
  });
  it('signOut limpa a sessão local e avisa o servidor', async () => {
    const storage = memStore(); storage.setItem('kobly_auth_v1', JSON.stringify(SESS()));
    const { client, calls } = mk(() => json({ ok: true }), { storage });
    await client.auth.signOut();
    expect(storage.getItem('kobly_auth_v1')).toBeNull();
    expect(calls[0].url).toMatch(/\/auth\/logout$/);
    expect((await client.auth.getSession()).data.session).toBeNull();
  });
  it('signUp sem sessão (confirmação) e com sessão', async () => {
    const a = mk(() => json({ user: { id: 'u' }, session: null, needsConfirmation: true }));
    const ra = await a.client.auth.signUp({ email: 'a@b.test', password: 'senha-forte-1', options: { data: { nome: 'X' } } });
    expect(ra.data.session).toBeNull(); expect(JSON.parse(a.calls[0].init.body).nome).toBe('X');
    const b = mk(() => json({ user: { id: 'u' }, session: SESS() }));
    expect((await b.client.auth.signUp({ email: 'a@b.test', password: 'senha-forte-1' })).data.session.access_token).toBe('AT');
  });
  it('updateUser com sessão usa /auth/password', async () => {
    const storage = memStore(); storage.setItem('kobly_auth_v1', JSON.stringify(SESS()));
    const { client, calls } = mk(() => json({ ok: true }), { storage });
    expect((await client.auth.updateUser({ password: 'nova-senha-1' })).error).toBeNull();
    expect(calls[0].url).toMatch(/\/auth\/password$/); expect(calls[0].init.headers.Authorization).toBe('Bearer AT');
  });
});

describe('funções, rpc, arquivos e tempo real', () => {
  it('rpc faz POST em /rest/v1/rpc/<fn> e devolve dados/erro', async () => {
    const ok = mk(() => json([{ n: 1 }]));
    expect((await ok.client.rpc('leads_page', { p: 1 })).data).toEqual([{ n: 1 }]);
    expect(ok.calls[0].url).toBe('http://api.test/rest/v1/rpc/leads_page');
    const bad = mk(() => json({ message: 'nope', code: 'P0001' }, 400));
    expect((await bad.client.rpc('x')).error.code).toBe('P0001');
  });
  it('functions.invoke: sucesso devolve o JSON; erro HTTP traz o Response em error.context', async () => {
    const ok = mk(() => json({ sent: true }));
    expect((await ok.client.functions.invoke('send-email', { body: { to: 'a' } })).data).toEqual({ sent: true });
    expect(ok.calls[0].url).toBe('http://api.test/functions/v1/send-email');
    const bad = mk(() => json({ error: 'x' }, 501));
    const r = await bad.client.functions.invoke('send-email', { body: {} });
    expect(r.error.name).toBe('FunctionsHttpError');
    expect(await r.error.context.json()).toEqual({ error: 'x' });
  });
  it('storage: URL pública e upload', async () => {
    const { client, calls } = mk(() => json({}));
    expect(client.storage.from('branding').getPublicUrl('o/logo.png').data.publicUrl).toBe('http://api.test/storage/v1/object/public/branding/o/logo.png');
    const r = await client.storage.from('branding').upload('o/logo.png', new Blob(['x']), { upsert: true, contentType: 'image/png' });
    expect(r.error).toBeNull(); expect(calls[0].url).toContain('/storage/v1/object/branding/o/logo.png?upsert=true');
  });
  it('canal: avisa SUBSCRIBED, ignora o que já existia e entrega só linhas novas', async () => {
    vi.useFakeTimers();
    let newest = '2026-01-01T00:00:00.000Z';
    const rows = [];
    const { client } = mk((u) => {
      const q = new URL(u).searchParams;
      if (q.get('limit') === '1') return json([{ created_at: newest }]);
      const gt = q.get('created_at');
      return json(rows.filter((r) => r.created_at > gt.replace('gt.', '')));
    }, { pollMs: 1000 });
    const got = []; const status = [];
    const ch = client.channel('c').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'support_messages' }, (p) => got.push(p.new.id)).subscribe((s) => status.push(s));
    await vi.advanceTimersByTimeAsync(10);
    expect(status).toContain('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(1100);   // 1º ciclo só marca o ponto de partida
    rows.push({ id: 'm1', created_at: '2026-01-02T00:00:00.000Z' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(got).toEqual(['m1']);
    await vi.advanceTimersByTimeAsync(2100);   // sem repetir a mesma linha
    expect(got).toEqual(['m1']);
    client.removeChannel(ch);
    rows.push({ id: 'm2', created_at: '2026-01-03T00:00:00.000Z' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(got).toEqual(['m1']);
    vi.useRealTimers();
  });
});
