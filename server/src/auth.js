// Login, sessões e cadastro do Kobly (substitui o Auth do Supabase).
//  - access token: JWT de 1 h (role kobly_authenticated; o PostgREST aplica a RLS por ele)
//  - refresh token: aleatório, só o SHA-256 fica no banco (auth.sessions), 30 dias, rotativo
//  - 5 falhas seguidas travam a conta por 15 min; erro único para senha errada/usuário inexistente
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword, dummyHash } from './password.js';
import { signJwt, verifyJwt } from './jwt.js';

export const ACCESS_TTL = 3600;
export const REFRESH_TTL = 30 * 24 * 3600;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function createAuth({ pool, jwtSecret, requireConfirm = false, mailer = null, allowedOrigins = [] }) {
  // O link do e-mail só pode apontar para uma origem permitida (evita phishing por redirect_to forjado).
  const safeRedirect = (u) => { try { const o = new URL(u).origin; return allowedOrigins.includes(o) ? o : (allowedOrigins[0] || null); } catch { return allowedOrigins[0] || null; } };
  const now = () => Math.floor(Date.now() / 1000);

  const userView = (u) => ({
    id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated',
    email_confirmed_at: u.email_confirmed_at, user_metadata: u.raw_user_meta_data || {},
  });

  async function issueSession(user, client = pool) {
    const iat = now();
    const access = signJwt({
      sub: user.id, email: user.email, role: 'kobly_authenticated', aud: 'authenticated', iat, exp: iat + ACCESS_TTL,
    }, jwtSecret);
    const refresh = randomBytes(32).toString('base64url');
    await client.query(
      `insert into auth.sessions (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(secs => $3))`,
      [sha256(refresh), user.id, REFRESH_TTL],
    );
    await client.query(`update auth.users set last_sign_in_at = now() where id = $1`, [user.id]);
    return { access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: ACCESS_TTL, expires_at: iat + ACCESS_TTL, user: userView(user) };
  }

  async function login(email, password) {
    const e = String(email || '').trim().toLowerCase();
    const { rows } = await pool.query(`select * from auth.users where lower(email) = $1`, [e]);
    const u = rows[0];
    if (!u) { await verifyPassword(password, await dummyHash()); throw new AuthError(400, 'invalid_credentials', 'Invalid login credentials'); }
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw new AuthError(429, 'too_many_attempts', 'Muitas tentativas. Tente novamente em alguns minutos.');
    const ok = await verifyPassword(password, u.encrypted_password);
    if (!ok || (u.banned_until && new Date(u.banned_until) > new Date())) {
      if (!ok) {
        await pool.query(
          `update auth.users set failed_attempts = failed_attempts + 1,
             locked_until = case when failed_attempts + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end
           where id = $1`, [u.id, MAX_FAILS, LOCK_MINUTES]);
      }
      throw new AuthError(400, 'invalid_credentials', 'Invalid login credentials');
    }
    if (requireConfirm && !u.email_confirmed_at) throw new AuthError(400, 'email_not_confirmed', 'Email not confirmed');
    await pool.query(`update auth.users set failed_attempts = 0, locked_until = null where id = $1`, [u.id]);
    // Usuário desabilitado pelo admin não entra (mesma regra do loadAppSession).
    const prof = await pool.query(`select status_user from public.profiles where auth_id = $1`, [u.id]);
    if (prof.rows[0] && prof.rows[0].status_user === 'Desabilitado') throw new AuthError(400, 'invalid_credentials', 'Invalid login credentials');
    return issueSession(u);
  }

  async function signup(email, password, nome, redirectTo) {
    const e = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(e)) throw new AuthError(422, 'validation_failed', 'E-mail inválido');
    if (String(password || '').length < 8) throw new AuthError(422, 'weak_password', 'A senha precisa ter pelo menos 8 caracteres');
    const hash = await hashPassword(password);
    let u;
    try {
      const r = await pool.query(
        `insert into auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at)
         values ($1, $2, $3::jsonb, case when $4 then null else now() end) returning *`,
        [e, hash, JSON.stringify({ nome: nome || '' }), requireConfirm],
      );
      u = r.rows[0];
    } catch (err) {
      // não revela se o e-mail já existe: mesma resposta de um cadastro novo pendente
      if (err.code === '23505') return { user: { email: e }, session: null, needsConfirmation: true };
      throw err;
    }
    if (requireConfirm) {
      const token = await createOneTimeToken(u.id, 'confirm', 24 * 3600);
      if (mailer) await mailer.sendConfirm(e, token, safeRedirect(redirectTo));
      return { user: userView(u), session: null, needsConfirmation: true };
    }
    return { user: userView(u), session: await issueSession(u), needsConfirmation: false };
  }

  async function createOneTimeToken(userId, purpose, ttlSecs) {
    const token = randomBytes(32).toString('base64url');
    await pool.query(
      `insert into auth.one_time_tokens (token_hash, user_id, purpose, expires_at) values ($1, $2, $3, now() + make_interval(secs => $4))`,
      [sha256(token), userId, purpose, ttlSecs],
    );
    return token;
  }

  // Refresh rotativo com TOLERÂNCIA de 60 s: o token antigo não é apagado na hora, só marcado. Se a resposta da
  // renovação se perder (aba fechada/recarregada no meio, celular descartou a aba), o token antigo ainda vale por
  // 1 minuto e a pessoa não é deslogada nem perde o que estava editando. Passado esse tempo, só o novo vale.
  const REUSE_GRACE_SECS = 60;
  async function refresh(refreshToken) {
    const h = sha256(String(refreshToken || ''));
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`delete from auth.sessions where rotated_at is not null and rotated_at < now() - make_interval(secs => $1)`, [REUSE_GRACE_SECS]);
      const cur = await client.query(`update auth.sessions set rotated_at = coalesce(rotated_at, now()) where token_hash = $1 and expires_at > now()
        and (rotated_at is null or rotated_at > now() - make_interval(secs => $2)) returning user_id`, [h, REUSE_GRACE_SECS]);
      if (!cur.rows[0]) { await client.query('rollback'); throw new AuthError(401, 'invalid_refresh_token', 'Invalid Refresh Token'); }
      const { rows } = await client.query(`select * from auth.users where id = $1`, [cur.rows[0].user_id]);
      if (!rows[0] || (rows[0].banned_until && new Date(rows[0].banned_until) > new Date())) { await client.query('rollback'); throw new AuthError(401, 'invalid_refresh_token', 'Invalid Refresh Token'); }
      const s = await issueSession(rows[0], client);
      await client.query('commit');
      return s;
    } catch (e) { try { await client.query('rollback'); } catch {} throw e; } finally { client.release(); }
  }

  async function logout(refreshToken) {
    if (refreshToken) await pool.query(`delete from auth.sessions where token_hash = $1`, [sha256(String(refreshToken))]);
  }

  async function userFromAccessToken(token) {
    const p = verifyJwt(token, jwtSecret);
    if (!p || !p.sub) throw new AuthError(401, 'bad_jwt', 'Invalid JWT');
    const { rows } = await pool.query(`select * from auth.users where id = $1`, [p.sub]);
    if (!rows[0] || (rows[0].banned_until && new Date(rows[0].banned_until) > new Date())) throw new AuthError(401, 'bad_jwt', 'Invalid JWT');
    return rows[0];
  }

  async function requestRecovery(email, redirectTo) {
    const e = String(email || '').trim().toLowerCase();
    const { rows } = await pool.query(`select id from auth.users where lower(email) = $1`, [e]);
    if (rows[0]) {
      const token = await createOneTimeToken(rows[0].id, 'recovery', 3600);
      if (mailer) await mailer.sendRecovery(e, token, safeRedirect(redirectTo));
    }
    // resposta idêntica exista ou não a conta
  }

  async function resetPassword(token, newPassword) {
    if (String(newPassword || '').length < 8) throw new AuthError(422, 'weak_password', 'A senha precisa ter pelo menos 8 caracteres');
    const hash = await hashPassword(newPassword);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const used = await client.query(
        `update auth.one_time_tokens set used_at = now()
          where token_hash = $1 and purpose = 'recovery' and used_at is null and expires_at > now() returning user_id`, [sha256(String(token || ''))]);
      if (!used.rows[0]) { await client.query('rollback'); throw new AuthError(400, 'invalid_token', 'Link inválido ou expirado'); }
      const uid = used.rows[0].user_id;
      await client.query(`update auth.users set encrypted_password = $2, failed_attempts = 0, locked_until = null, updated_at = now() where id = $1`, [uid, hash]);
      await client.query(`delete from auth.sessions where user_id = $1`, [uid]); // derruba as sessões antigas
      const { rows: urows } = await client.query(`select * from auth.users where id = $1`, [uid]);
      const sess = await issueSession(urows[0], client); // já entra logado com a senha nova
      await client.query('commit');
      return sess;
    } catch (e) { try { await client.query('rollback'); } catch {} throw e; } finally { client.release(); }
  }

  async function changePassword(user, newPassword) {
    if (String(newPassword || '').length < 8) throw new AuthError(422, 'weak_password', 'A senha precisa ter pelo menos 8 caracteres');
    await pool.query(`update auth.users set encrypted_password = $2, updated_at = now() where id = $1`, [user.id, await hashPassword(newPassword)]);
  }

  async function confirmEmail(token) {
    const used = await pool.query(
      `update auth.one_time_tokens set used_at = now()
        where token_hash = $1 and purpose = 'confirm' and used_at is null and expires_at > now() returning user_id`, [sha256(String(token || ''))]);
    if (!used.rows[0]) throw new AuthError(400, 'invalid_token', 'Link inválido ou expirado');
    await pool.query(`update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1`, [used.rows[0].user_id]);
  }

  return { safeRedirect, login, signup, refresh, logout, userFromAccessToken, requestRecovery, resetPassword, changePassword, confirmEmail, userView, createOneTimeToken };
}
