// Rotas /functions/v1/<nome>: substituem as Edge Functions do Supabase, uma por vez.
// Enquanto uma função não foi portada, responde 501 com um aviso claro (a tela mostra o erro
// em vez de falhar em silêncio). Cada handler recebe (ctx, req, res, io).
import { AuthError } from '../auth.js';

export function createFunctions(ctx) {
  const handlers = {
    // 'send-email': (ctx) => async (req, res, io) => {...}   ← entram nas próximas etapas
  };
  return {
    names: () => Object.keys(handlers),
    async handle(name, req, res, io) {
      if (req.method !== 'POST') throw new AuthError(405, 'method_not_allowed', 'Use POST');
      const h = handlers[name];
      if (!h) {
        // consome o corpo para não deixar a conexão pendurada
        await io.readBody(req, 64 * 1024).catch(() => {});
        return io.send(res, 501, { code: 'not_ported', error: 'not_ported', message: `A função "${name}" ainda não está disponível neste ambiente.` });
      }
      return h(ctx)(req, res, io);
    },
  };
}
