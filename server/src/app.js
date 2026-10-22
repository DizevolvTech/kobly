import { createMailer } from './mailer.js';
import { createInvites } from './invite.js';
import { createEngine } from './engine/steps.js';
import { createPostback } from './ingest/postback.js';
import { createServer } from 'node:http';
import { createAuth, AuthError } from './auth.js';
import { createLimiter } from './ratelimit.js';
import { createFunctions } from './functions/index.js';
import { createWhatsapp } from './whatsapp/service.js';
import { createGraph } from './whatsapp/graph.js';
import { parseKey } from './whatsapp/crypto.js';

const MAX_BODY = 64 * 1024;
const MAX_PROXY_BODY = 5 * 1024 * 1024;
// Cabeçalhos do cliente que podem seguir para o PostgREST (o resto é descartado).
const FORWARD_REQ = ['authorization', 'content-type', 'accept', 'prefer', 'range', 'range-unit', 'accept-profile', 'content-profile'];
const FORWARD_RES = ['content-type', 'content-range', 'content-profile', 'preference-applied', 'location'];

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new AuthError(413, 'too_large', 'Corpo grande demais')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, MAX_BODY);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString()); } catch { throw new AuthError(400, 'bad_json', 'JSON inválido'); }
}

export function createApp({ pool, config, mailer: mailerIn = null, fetchImpl = globalThis.fetch, graph = null }) {
  const mailer = mailerIn || createMailer({ apiKey: config.resendApiKey, from: config.mailFrom, siteUrl: config.siteUrl || (config.allowedOrigins || [])[0] || '' });
  const auth = createAuth({ pool, jwtSecret: config.jwtSecret, requireConfirm: config.requireConfirm, mailer, allowedOrigins: config.allowedOrigins || [] });
  const whatsapp = createWhatsapp({
    pool, graph: graph || createGraph({ base: config.metaGraphBase }),
    secretKey: config.secretKey ? parseKey(config.secretKey) : null,
    publicBaseUrl: config.publicBaseUrl || '', globalAppSecret: config.metaAppSecret || null,
  });
  const postback = createPostback({ pool });
  const invites = createInvites({ pool, auth, mailer });
  const functions = createFunctions({ pool, config, auth, mailer, whatsapp, invites });
  // Por IP (escritórios compartilham IP, então o teto é alto); o freio por conta fica em auth.js.
  const loginLimit = createLimiter({ max: config.loginPerMin ?? 60, windowMs: 60_000 });
  const signupLimit = createLimiter({ max: config.signupPerMin ?? 20, windowMs: 60_000 });

  const clientIp = (req) => (config.trustProxy && (req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())) || req.socket.remoteAddress || 'unknown';

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && (config.allowedOrigins || []).includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, accept, prefer, range, range-unit, accept-profile, content-profile, x-client-info, apikey');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'content-range, content-profile, preference-applied');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }
  const send = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };
  const bearer = (req) => { const m = /^Bearer (.+)$/i.exec(req.headers.authorization || ''); return m ? m[1] : null; };

  const routes = {
    'POST /auth/login': async (req, res, body) => {
      if (!loginLimit(clientIp(req))) throw new AuthError(429, 'rate_limited', 'Muitas tentativas');
      send(res, 200, await auth.login(body.email, body.password));
    },
    'POST /auth/signup': async (req, res, body) => {
      if (!signupLimit(clientIp(req))) throw new AuthError(429, 'rate_limited', 'Muitas tentativas');
      send(res, 200, await auth.signup(body.email, body.password, body.nome, body.redirect_to));
    },
    'POST /auth/refresh': async (req, res, body) => send(res, 200, await auth.refresh(body.refresh_token)),
    'POST /auth/logout': async (req, res, body) => { await auth.logout(body.refresh_token); send(res, 200, { ok: true }); },
    'GET /auth/user': async (req, res) => send(res, 200, auth.userView(await auth.userFromAccessToken(bearer(req)))),
    'POST /auth/recover': async (req, res, body) => {
      if (!signupLimit(clientIp(req))) throw new AuthError(429, 'rate_limited', 'Muitas tentativas');
      await auth.requestRecovery(body.email, body.redirect_to); send(res, 200, { ok: true });
    },
    'POST /auth/reset': async (req, res, body) => send(res, 200, await auth.resetPassword(body.token, body.password)),
    'POST /auth/confirm': async (req, res, body) => { await auth.confirmEmail(body.token); send(res, 200, { ok: true }); },
    'POST /auth/password': async (req, res, body) => {
      const u = await auth.userFromAccessToken(bearer(req));
      await auth.changePassword(u, body.password); send(res, 200, { ok: true });
    },
    'GET /health': async (req, res) => { await pool.query('select 1'); send(res, 200, { ok: true }); },
  };

  // /rest/v1/* → PostgREST (o JWT é validado lá; o banco aplica a RLS).
  async function proxyRest(req, res, url) {
    if (!config.postgrestUrl) throw new AuthError(503, 'rest_unavailable', 'Serviço de dados indisponível');
    const target = config.postgrestUrl.replace(/\/$/, '') + url.pathname.replace(/^\/rest\/v1/, '') + url.search;
    const headers = {};
    for (const h of FORWARD_REQ) if (req.headers[h]) headers[h] = req.headers[h];
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const body = hasBody ? await readBody(req, MAX_PROXY_BODY) : undefined;
    let up;
    try { up = await fetchImpl(target, { method: req.method, headers, body: hasBody && body.length ? body : undefined }); }
    catch { throw new AuthError(502, 'rest_unreachable', 'Serviço de dados não respondeu'); }
    res.statusCode = up.status;
    for (const h of FORWARD_RES) { const v = up.headers.get(h); if (v) res.setHeader(h, v); }
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(await up.arrayBuffer()));
  }

  const server = createServer(async (req, res) => {
    cors(req, res);
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/rest/v1' || path.startsWith('/rest/v1/')) return await proxyRest(req, res, url);
      const wm = /^\/webhooks\/whatsapp\/([0-9a-f-]{36})$/.exec(path);
      if (wm) {
        if (req.method === 'GET') {
          const challenge = await whatsapp.verifyWebhook(wm[1], url.searchParams.get('hub.mode'), url.searchParams.get('hub.verify_token'), url.searchParams.get('hub.challenge'));
          res.statusCode = challenge === null ? 403 : 200; res.setHeader('Content-Type', 'text/plain'); return res.end(challenge === null ? 'forbidden' : challenge);
        }
        if (req.method === 'POST') {
          const raw = await readBody(req, MAX_PROXY_BODY);
          const r = await whatsapp.receiveWebhook(wm[1], raw, req.headers['x-hub-signature-256']);
          const { status: st, ...counts } = r;
          return send(res, st, st === 200 ? { ok: true, ...counts } : { code: 'rejected' });
        }
      }
      if (path === '/functions/v1/postback-receiver' && req.method === 'POST') {
        const r = await postback.receive(url.searchParams.get('token'), (await readBody(req, MAX_PROXY_BODY)).toString('utf8'));
        return send(res, r.status, r.body);
      }
      const fm = /^\/functions\/v1\/([a-z0-9-]+)$/.exec(path);
      if (fm) return await functions.handle(fm[1], req, res, { readJson, readBody, send, bearer, clientIp });
      const handler = routes[`${req.method} ${path}`];
      if (!handler) return send(res, 404, { code: 'not_found', message: 'Not found' });
      const body = req.method === 'POST' ? await readJson(req) : {};
      await handler(req, res, body);
    } catch (e) {
      if (e instanceof AuthError) return send(res, e.status, { code: e.code, error: e.code, message: e.message });
      console.error('[kobly-api]', e && e.message);
      send(res, 500, { code: 'internal', message: 'Erro interno' });
    }
  });
  const engine = createEngine({ pool, whatsapp });
  return { server, auth, engine };
}
