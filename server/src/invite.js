// Convite de cliente: Administrador ou Gestor da conta cria o acesso do cliente (e-mail + conta), o cliente recebe
// um link para DEFINIR A SENHA e já entra com perfil Cliente na conta. O perfil/conta vêm do SERVIDOR, nunca do corpo.
import { AuthError } from './auth.js';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const INVITE_TTL = 7 * 24 * 3600;

export function createInvites({ pool, auth, mailer }) {
  async function invite(caller, { org_id, email, nome }) {
    const orgId = String(org_id || '').trim();
    const e = String(email || '').trim().toLowerCase();
    if (!orgId || !EMAIL_RE.test(e)) throw new AuthError(400, 'missing_fields', 'Informe a conta e um e-mail válido.');
    const prof = (await pool.query(`select id, nome, tipo_user_geral, organization_id from public.profiles where auth_id = $1`, [caller.id])).rows[0];
    if (!prof) throw new AuthError(403, 'forbidden', 'Sem perfil.');
    const role = String(prof.tipo_user_geral);
    const access = role === 'Administrador' || prof.organization_id === orgId
      || (await pool.query(`select 1 from public.organization_memberships where organization_id = $1 and profile_id = $2`, [orgId, prof.id])).rows.length > 0;
    if (!access || (role !== 'Administrador' && role !== 'Gestor')) throw new AuthError(403, 'forbidden', 'Apenas Administrador ou Gestor da conta podem convidar.');
    const org = (await pool.query(`select nome from public.organizations where id = $1`, [orgId])).rows[0];
    if (!org) throw new AuthError(404, 'org_not_found', 'Conta não encontrada.');

    const existing = (await pool.query(`select u.id, u.last_sign_in_at, p.organization_id from auth.users u left join public.profiles p on p.auth_id = u.id where lower(u.email) = $1`, [e])).rows[0];
    let userId, created = false;
    if (existing) {
      // Quem já tem acesso em OUTRA conta não é puxado para esta (um gestor não pode sequestrar o usuário de outra empresa).
      if (existing.organization_id && existing.organization_id !== orgId) throw new AuthError(409, 'email_in_use', 'Este e-mail já pertence a outra conta da Kobly.');
      if (existing.last_sign_in_at) return { ok: true, invited: false, already_exists: true };       // já entrou: nada a convidar
      userId = existing.id;                                                                          // convite pendente: reenvia
      await pool.query(`update public.profiles set organization_id = $2 where auth_id = $1 and organization_id is null`, [userId, orgId]);
    } else {
      const r = await pool.query(`insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data, email_confirmed_at)
        values ($1, null, $2::jsonb, $3::jsonb, now()) returning id`, [e, JSON.stringify({ nome: nome || '' }), JSON.stringify({ tipo_user_geral: 'Cliente', organization_id: orgId })]);
      userId = r.rows[0].id; created = true;
    }
    const token = await auth.createOneTimeToken(userId, 'recovery', INVITE_TTL);
    const origin = null;                                                                       // usa SITE_URL do e-mail
    const mail = await mailer.sendInvite(e, token, origin, { nome: String(nome || '').trim(), conta: org.nome, convidadoPor: prof.nome || '' });
    // Sem provedor de e-mail, quem convida recebe o link para repassar. Com e-mail enviado, o link NÃO é devolvido.
    return { ok: true, invited: true, resent: !created, emailed: !!mail.sent, ...(mail.sent ? {} : { access_link: mailer.inviteLink(origin, token) }) };
  }
  return { invite };
}
