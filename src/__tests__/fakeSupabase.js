// Supabase falso em memória para testes de interface: responde às consultas do app
// com as linhas semeadas (ou vazio). Sem rede, sem banco real.
export function makeFakeSupabase(tables = {}) {
  const chain = (rows) => {
    let data = rows;
    const api = {
      select: () => api, order: () => api, limit: () => api, eq: () => api, in: () => api, neq: () => api,
      gte: () => api, lte: () => api, gt: () => api, lt: () => api, is: () => api, not: () => api, or: () => api,
      ilike: () => api, like: () => api, contains: () => api, range: () => api, filter: () => api, match: () => api,
      insert: () => api, update: () => api, upsert: () => api, delete: () => api,
      single: () => Promise.resolve({ data: data[0] || null, error: null }),
      maybeSingle: () => Promise.resolve({ data: data[0] || null, error: null }),
      then: (res, rej) => Promise.resolve({ data, error: null, count: data.length }).then(res, rej),
    };
    return api;
  };
  const listeners = [];
  const channel = () => { const ch = { on: () => ch, subscribe: () => ch, unsubscribe: () => {} }; return ch; };
  return {
    from: (t) => chain(tables[t] || []),
    rpc: () => Promise.resolve({ data: null, error: null }),
    functions: { invoke: () => Promise.resolve({ data: {}, error: null }) },
    storage: { from: () => ({ upload: async () => ({ data: {}, error: null }), getPublicUrl: () => ({ data: { publicUrl: '' } }), createSignedUrl: async () => ({ data: { signedUrl: '' }, error: null }) }) },
    channel, removeChannel: () => {},
    realtime: { setAuth: () => {} },
    auth: {
      getUser: async () => ({ data: { user: { id: 'auth-1' } } }),
      getSession: async () => ({ data: { session: { access_token: 't', user: { id: 'auth-1' } } } }),
      onAuthStateChange: (cb) => { listeners.push(cb); setTimeout(() => cb('INITIAL_SESSION', { access_token: 't', user: { id: 'auth-1' } }), 0); return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithPassword: async () => ({ error: null }), signOut: async () => ({ error: null }),
      signUp: async () => ({ data: {}, error: null }), resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }),
    },
  };
}
