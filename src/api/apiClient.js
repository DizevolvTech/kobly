// Cliente da API do Kobly com a mesma forma de uso do supabase-js (subconjunto usado pelo app).
// Sem dependências; recebe `fetch`/`storage` por injeção para ser testável.

const SESSION_KEY = 'kobly_auth_v1';
const SKEW = 60; // renova o token 60 s antes de vencer

function err(message, extra = {}) { return { message, ...extra }; }

// ---- valores de filtro no formato PostgREST --------------------------------
function lit(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
function inList(vals) {
  return `(${vals.map((v) => {
    const s = lit(v);
    return /[,()"\\\s]/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s;
  }).join(',')})`;
}

class QueryBuilder {
  constructor(client, table) {
    this.c = client;
    this.table = table;
    this.method = 'GET';
    this.params = new URLSearchParams();
    this.headers = {};
    this.body = undefined;
    this.wantRows = true; // só afeta mutações: precisa de .select() para devolver linhas
    this.mode = 'many'; // many | single | maybe
    this.head = false;
  }

  // -- ações ------------------------------------------------------------------
  select(columns = '*', opts = {}) {
    const cols = String(columns).replace(/\s+/g, '');
    this.params.set('select', cols);
    if (this.method !== 'GET') { this.headers.Prefer = this._prefer({ 'return': 'representation' }); }
    if (opts.count) this.headers.Prefer = this._prefer({ count: opts.count });
    if (opts.head) this.head = true;
    return this;
  }
  insert(values, opts = {}) {
    this.method = 'POST';
    this.body = values;
    this.headers.Prefer = this._prefer({ 'return': 'minimal' });
    if (opts.defaultToNull === false) this.headers.Prefer = this._prefer({ missing: 'default' });
    return this;
  }
  upsert(values, opts = {}) {
    this.method = 'POST';
    this.body = values;
    if (opts.onConflict) this.params.set('on_conflict', opts.onConflict);
    this.headers.Prefer = this._prefer({
      'return': 'minimal',
      resolution: opts.ignoreDuplicates ? 'ignore-duplicates' : 'merge-duplicates',
    });
    return this;
  }
  update(values) {
    this.method = 'PATCH';
    this.body = values;
    this.headers.Prefer = this._prefer({ 'return': 'minimal' });
    return this;
  }
  delete() {
    this.method = 'DELETE';
    this.headers.Prefer = this._prefer({ 'return': 'minimal' });
    return this;
  }
  _prefer(add) {
    const cur = {};
    String(this.headers.Prefer || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((p) => {
      const [k, v] = p.split('='); cur[k] = v;
    });
    Object.assign(cur, add);
    return Object.entries(cur).map(([k, v]) => `${k}=${v}`).join(',');
  }

  // -- filtros ----------------------------------------------------------------
  _f(col, op, val) { this.params.append(col, `${op}.${val}`); return this; }
  eq(c, v) { return this._f(c, 'eq', lit(v)); }
  neq(c, v) { return this._f(c, 'neq', lit(v)); }
  gt(c, v) { return this._f(c, 'gt', lit(v)); }
  gte(c, v) { return this._f(c, 'gte', lit(v)); }
  lt(c, v) { return this._f(c, 'lt', lit(v)); }
  lte(c, v) { return this._f(c, 'lte', lit(v)); }
  like(c, v) { return this._f(c, 'like', lit(v)); }
  ilike(c, v) { return this._f(c, 'ilike', lit(v)); }
  is(c, v) { return this._f(c, 'is', lit(v)); }
  in(c, vals) { return this._f(c, 'in', inList(vals)); }
  contains(c, v) { return this._f(c, 'cs', Array.isArray(v) ? `{${v.map(lit).join(',')}}` : JSON.stringify(v)); }
  not(c, op, v) { return this._f(c, `not.${op}`, Array.isArray(v) ? inList(v) : lit(v)); }
  or(expr) { this.params.append('or', `(${expr})`); return this; }
  filter(c, op, v) { return this._f(c, op, lit(v)); }
  match(obj) { Object.entries(obj).forEach(([k, v]) => this.eq(k, v)); return this; }

  // -- modificadores ----------------------------------------------------------
  order(col, { ascending = true, nullsFirst } = {}) {
    const dir = `${col}.${ascending ? 'asc' : 'desc'}${nullsFirst === undefined ? '' : (nullsFirst ? '.nullsfirst' : '.nullslast')}`;
    this.params.set('order', this.params.has('order') ? `${this.params.get('order')},${dir}` : dir);
    return this;
  }
  limit(n) { this.params.set('limit', String(n)); return this; }
  range(from, to) { this.params.set('offset', String(from)); this.params.set('limit', String(to - from + 1)); return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }

  then(resolve, reject) { return this._run().then(resolve, reject); }

  async _run() {
    const wantsRows = this.method === 'GET' || String(this.headers.Prefer || '').includes('return=representation');
    const headers = { ...this.headers };
    if (this.mode === 'single' && wantsRows) headers.Accept = 'application/vnd.pgrst.object+json';
    const qs = this.params.toString();
    const url = `${this.c.baseUrl}/rest/v1/${this.table}${qs ? `?${qs}` : ''}`;
    const method = this.head ? 'HEAD' : this.method;
    let res;
    try {
      res = await this.c.authed(url, { method, headers, body: this.body === undefined ? undefined : JSON.stringify(this.body) });
    } catch (e) {
      return { data: null, error: err(e.message || 'Falha de rede'), count: null, status: 0 };
    }
    const status = res.status;
    let count = null;
    const cr = res.headers.get('content-range');
    if (cr && cr.includes('/') && !cr.endsWith('/*')) count = Number(cr.split('/')[1]);
    if (!res.ok) {
      let j = null; try { j = await res.json(); } catch { /* corpo vazio */ }
      return { data: null, error: { message: (j && j.message) || res.statusText || 'Erro', code: j && j.code, details: j && j.details, hint: j && j.hint }, count, status };
    }
    if (this.head) return { data: null, error: null, count, status };
    if (!wantsRows || status === 204) return { data: null, error: null, count, status };
    let data;
    try { data = await res.json(); } catch { data = null; }
    if (this.mode === 'maybe' && Array.isArray(data)) {
      if (data.length > 1) return { data: null, error: err('JSON object requested, multiple (or no) rows returned', { code: 'PGRST116' }), count, status: 406 };
      data = data[0] || null;
    }
    return { data, error: null, count, status };
  }
}

// ---- Realtime por consulta periódica (substitui o websocket do Supabase) ----
class PollingChannel {
  constructor(client, name) { this.c = client; this.name = name; this.subs = []; this.timer = null; this.state = {}; }
  on(type, filter, cb) { if (type === 'postgres_changes') this.subs.push({ filter, cb }); return this; }
  subscribe(statusCb) {
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      for (const s of this.subs) {
        const { table, event = '*' } = s.filter;
        const st = (this.state[table + event] ||= { mark: null });
        const col = event === 'INSERT' ? 'created_at' : 'updated_at';
        try {
          if (!st.mark) {
            const { data } = await new QueryBuilder(this.c, table).select(col).order(col, { ascending: false }).limit(1);
            st.mark = (data && data[0] && data[0][col]) || new Date(0).toISOString();
            continue;
          }
          const { data, error } = await new QueryBuilder(this.c, table).select('*').gt(col, st.mark).order(col, { ascending: true }).limit(200);
          if (error) throw new Error(error.message);
          for (const row of data || []) {
            st.mark = row[col] > st.mark ? row[col] : st.mark;
            const inserted = row.created_at && row.created_at === row.updated_at || event === 'INSERT';
            s.cb({ eventType: inserted ? 'INSERT' : 'UPDATE', new: row, old: {}, table, schema: 'public' });
          }
        } catch (e) { /* tenta de novo no próximo ciclo */ }
      }
    };
    this.timer = setInterval(tick, this.c.pollMs);
    Promise.resolve().then(() => { if (this.running && statusCb) statusCb('SUBSCRIBED'); tick(); });
    return this;
  }
  unsubscribe() { this.running = false; clearInterval(this.timer); return 'ok'; }
}

export function createApiClient({ baseUrl, fetchImpl, storage, pollMs = 4000, now = () => Math.floor(Date.now() / 1000) }) {
  const f = (...a) => (fetchImpl || globalThis.fetch)(...a);
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null, setItem() {}, removeItem() {} });
  const listeners = new Set();
  let session = null;
  let recoveryToken = null;
  let refreshing = null;

  try { const raw = store.getItem(SESSION_KEY); if (raw) session = JSON.parse(raw); } catch { session = null; }

  const emit = (event, sess) => listeners.forEach((cb) => { try { cb(event, sess); } catch (e) { console.error(e); } });
  const persist = (s) => {
    session = s;
    try { s ? store.setItem(SESSION_KEY, JSON.stringify(s)) : store.removeItem(SESSION_KEY); } catch { /* sem armazenamento */ }
  };

  async function post(path, body, token) {
    const res = await f(`${baseUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body || {}),
    });
    let j = null; try { j = await res.json(); } catch { /* sem corpo */ }
    return { ok: res.ok, status: res.status, json: j };
  }

  async function refreshSession() {
    if (!session || !session.refresh_token) return null;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const r = await post('/auth/refresh', { refresh_token: session.refresh_token });
      if (!r.ok) { persist(null); emit('SIGNED_OUT', null); return null; }
      persist(r.json); emit('TOKEN_REFRESHED', r.json); return r.json;
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }

  async function accessToken() {
    if (!session) return null;
    if (session.expires_at - now() < SKEW) { const s = await refreshSession(); return s ? s.access_token : null; }
    return session.access_token;
  }

  // fetch com Authorization; se o servidor disser 401, renova uma vez e repete
  async function authed(url, init = {}) {
    const run = async (tok) => f(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers || {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    });
    let res = await run(await accessToken());
    if (res.status === 401 && session) { const s = await refreshSession(); if (s) res = await run(s.access_token); }
    return res;
  }

  // link de recuperação de senha volta com #type=recovery&token=...
  if (typeof window !== 'undefined' && window.location && /type=recovery/.test(window.location.hash || '')) {
    const p = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    recoveryToken = p.get('token');
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* noop */ }
    setTimeout(() => emit('PASSWORD_RECOVERY', null), 0);
  }

  const auth = {
    async signInWithPassword({ email, password }) {
      const r = await post('/auth/login', { email, password });
      if (!r.ok) return { data: { user: null, session: null }, error: err((r.json && r.json.message) || 'Falha no login', { status: r.status, code: r.json && r.json.code }) };
      persist(r.json); emit('SIGNED_IN', r.json);
      return { data: { user: r.json.user, session: r.json }, error: null };
    },
    async signUp({ email, password, options = {} }) {
      const r = await post('/auth/signup', { email, password, nome: options.data && options.data.nome, redirect_to: options.emailRedirectTo });
      if (!r.ok) return { data: { user: null, session: null }, error: err((r.json && r.json.message) || 'Falha no cadastro', { status: r.status }) };
      if (r.json.session) { persist(r.json.session); emit('SIGNED_IN', r.json.session); }
      return { data: { user: r.json.user, session: r.json.session || null }, error: null };
    },
    async signOut() {
      const rt = session && session.refresh_token;
      persist(null);
      if (rt) { try { await post('/auth/logout', { refresh_token: rt }); } catch { /* offline */ } }
      emit('SIGNED_OUT', null);
      return { error: null };
    },
    async getSession() {
      if (session && session.expires_at - now() < SKEW) await refreshSession();
      return { data: { session }, error: null };
    },
    async getUser() {
      const tok = await accessToken();
      if (!tok) return { data: { user: null }, error: err('Auth session missing!') };
      const res = await authed(`${baseUrl}/auth/user`, { method: 'GET' });
      if (!res.ok) return { data: { user: null }, error: err('Invalid JWT', { status: res.status }) };
      return { data: { user: await res.json() }, error: null };
    },
    onAuthStateChange(cb) {
      listeners.add(cb);
      setTimeout(() => { if (listeners.has(cb)) cb('INITIAL_SESSION', session); }, 0);
      return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
    },
    async resetPasswordForEmail(email, { redirectTo } = {}) {
      const r = await post('/auth/recover', { email, redirect_to: redirectTo });
      return r.ok ? { data: {}, error: null } : { data: null, error: err((r.json && r.json.message) || 'Falha ao enviar o e-mail', { status: r.status }) };
    },
    async updateUser({ password }) {
      if (recoveryToken) {
        const r = await post('/auth/reset', { token: recoveryToken, password });
        if (!r.ok) return { data: null, error: err((r.json && r.json.message) || 'Link inválido ou expirado', { status: r.status }) };
        recoveryToken = null;
        persist(r.json); emit('SIGNED_IN', r.json);
        return { data: { user: r.json.user }, error: null };
      }
      const tok = await accessToken();
      if (!tok) return { data: null, error: err('Auth session missing!') };
      const r = await post('/auth/password', { password }, tok);
      return r.ok ? { data: {}, error: null } : { data: null, error: err((r.json && r.json.message) || 'Falha ao atualizar a senha', { status: r.status }) };
    },
  };

  return {
    baseUrl,
    pollMs,
    authed,
    auth,
    from: (table) => new QueryBuilder({ baseUrl, authed, pollMs }, table),
    async rpc(fn, args = {}, opts = {}) {
      const res = await authed(`${baseUrl}/rest/v1/rpc/${fn}`, { method: opts.get ? 'GET' : 'POST', body: opts.get ? undefined : JSON.stringify(args) });
      let j = null; try { j = await res.json(); } catch { /* sem corpo */ }
      if (!res.ok) return { data: null, error: { message: (j && j.message) || 'Erro', code: j && j.code, details: j && j.details, hint: j && j.hint }, status: res.status };
      return { data: j, error: null, status: res.status };
    },
    functions: {
      async invoke(name, { body, headers } = {}) {
        const res = await authed(`${baseUrl}/functions/v1/${name}`, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
        if (!res.ok) return { data: null, error: { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code', context: res } };
        let data = null;
        const ct = res.headers.get('content-type') || '';
        try { data = ct.includes('json') ? await res.json() : await res.text(); } catch { data = null; }
        return { data, error: null };
      },
    },
    storage: {
      from: (bucket) => ({
        async upload(path, file, opts = {}) {
          const tok = await accessToken();
          const res = await f(`${baseUrl}/storage/v1/object/${bucket}/${path}${opts.upsert ? '?upsert=true' : ''}`, {
            method: 'POST', headers: { 'Content-Type': opts.contentType || (file && file.type) || 'application/octet-stream', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: file,
          });
          if (!res.ok) { let j = null; try { j = await res.json(); } catch { /* */ } return { data: null, error: err((j && j.message) || 'Falha no envio do arquivo', { status: res.status }) }; }
          return { data: { path }, error: null };
        },
        getPublicUrl: (path) => ({ data: { publicUrl: `${baseUrl}/storage/v1/object/public/${bucket}/${path}` } }),
      }),
    },
    channel: (name) => new PollingChannel({ baseUrl, authed, pollMs }, name),
    removeChannel: (ch) => { try { ch.unsubscribe(); } catch { /* noop */ } },
    realtime: { setAuth() {} },
  };
}
