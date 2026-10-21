import { createServer } from 'node:http';
import { createAuth, AuthError } from './auth.js';
import { createLimiter } from './ratelimit.js';

const MAX_BODY = 64 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new AuthError(413, 'too_large', 'Corpo grande demais')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new AuthError(400, 'bad_json', 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}

export function createApp({ pool, config, mailer = null }) {
  const auth = createAuth({ pool, jwtSecret: config.jwtSecret, requireConfirm: config.requireConfirm, mailer });
  // Por IP (escritórios compartilham IP, então o teto é alto); o freio por conta fica em auth.js.
  const loginLimit = createLimiter({ max: config.loginPerMin ?? 60, windowMs: 60_000 });
  const signupLimit = createLimiter({ max: config.signupPerMin ?? 20, windowMs: 60_000 });

  const clientIp = (req) => (config.trustProxy && (req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())) || req.socket.remoteAddress || 'unknown';

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
      send(res, 200, await auth.signup(body.email, body.password, body.nome));
    },
    'POST /auth/refresh': async (req, res, body) => send(res, 200, await auth.refresh(body.refresh_token)),
    'POST /auth/logout': async (req, res, body) => { await auth.logout(body.refresh_token); send(res, 200, { ok: true }); },
    'GET /auth/user': async (req, res) => send(res, 200, auth.userView(await auth.userFromAccessToken(bearer(req)))),
    'POST /auth/recover': async (req, res, body) => {
      if (!signupLimit(clientIp(req))) throw new AuthError(429, 'rate_limited', 'Muitas tentativas');
      await auth.requestRecovery(body.email); send(res, 200, { ok: true });
    },
    'POST /auth/reset': async (req, res, body) => { await auth.resetPassword(body.token, body.password); send(res, 200, { ok: true }); },
    'POST /auth/confirm': async (req, res, body) => { await auth.confirmEmail(body.token); send(res, 200, { ok: true }); },
    'POST /auth/password': async (req, res, body) => {
      const u = await auth.userFromAccessToken(bearer(req));
      await auth.changePassword(u, body.password); send(res, 200, { ok: true });
    },
    'GET /health': async (req, res) => { await pool.query('select 1'); send(res, 200, { ok: true }); },
  };

  const server = createServer(async (req, res) => {
    cors(req, res);
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
    const handler = routes[`${req.method} ${path}`];
    if (!handler) return send(res, 404, { code: 'not_found', message: 'Not found' });
    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      await handler(req, res, body);
    } catch (e) {
      if (e instanceof AuthError) return send(res, e.status, { code: e.code, error: e.code, message: e.message });
      console.error('[kobly-api]', e && e.message);
      send(res, 500, { code: 'internal', message: 'Erro interno' });
    }
  });
  return { server, auth };
}
