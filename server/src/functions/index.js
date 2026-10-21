// Rotas /functions/v1/<nome>: substituem as Edge Functions do Supabase, uma por vez.
// Enquanto uma função não foi portada, responde 501 com um aviso claro (a tela mostra o erro
// em vez de falhar em silêncio). Cada handler recebe (ctx, req, res, io).
import { AuthError } from '../auth.js';

const bearerOf = (req) => { const m = /^Bearer (.+)$/i.exec(req.headers.authorization || ''); return m ? m[1] : null; };

export function createFunctions(ctx) {
  const wa = ctx.whatsapp;
  // Exige usuário logado e devolve o usuário + a empresa-alvo.
  async function authedOrg(req, body) {
    const user = await ctx.auth.userFromAccessToken(bearerOf(req));
    const org = await wa.resolveOrg(user, body.org_id || null);
    return { user, org };
  }
  const whatsappAccount = async (req, res, io) => {
    const body = await io.readJson(req);
    const { org } = await authedOrg(req, body);
    switch (body.action) {
      case 'status': return io.send(res, 200, await wa.status(org, { refresh: !!body.refresh }));
      case 'connect': return io.send(res, 200, await wa.connect(org, body));
      case 'disconnect': return io.send(res, 200, await wa.disconnect(org));
      case 'sync_templates': return io.send(res, 200, await wa.syncTemplates(org));
      case 'create_template': return io.send(res, 200, await wa.createTemplate(org, body));
      case 'send_test': return io.send(res, 200, await wa.sendTemplateTo(org.orgId, { to: body.to, template_id: body.template_id, variables: body.variables || [], button_suffix: body.button_suffix }));
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  };
  const handlers = {
    'whatsapp-account': () => whatsappAccount,
  };
  return {
    names: () => Object.keys(handlers),
    async handle(name, req, res, io) {
      if (req.method !== 'POST') throw new AuthError(405, 'method_not_allowed', 'Use POST');
      const h = handlers[name];
      if (!h) {
        await io.readBody(req, 64 * 1024).catch(() => {});
        return io.send(res, 501, { code: 'not_ported', error: 'not_ported', message: `A função "${name}" ainda não está disponível neste ambiente.` });
      }
      return h(ctx)(req, res, io);
    },
  };
}
