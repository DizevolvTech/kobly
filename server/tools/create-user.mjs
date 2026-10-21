// Cria (ou atualiza a senha de) um usuário de teste/operação no banco do Kobly.
//   DATABASE_URL=... KOBLY_NEW_PASSWORD=... node tools/create-user.mjs <email> <Papel> "<Nome>" [Organização]
// Papel: Cliente | Gestor | Suporte | Administrador. A senha vem do ambiente (nunca de argv).
// Cliente ganha uma organização própria (plano Starter) pela mesma função do cadastro real.
import pg from 'pg';
import { hashPassword } from '../src/password.js';

const [email, papel, nome, org] = process.argv.slice(2);
const PAPEIS = ['Cliente', 'Gestor', 'Suporte', 'Administrador'];
if (!email || !PAPEIS.includes(papel) || !nome) { console.error('uso: create-user.mjs <email> <Cliente|Gestor|Suporte|Administrador> "<Nome>" [Organização]'); process.exit(2); }
const password = process.env.KOBLY_NEW_PASSWORD;
if (!password || password.length < 12) { console.error('KOBLY_NEW_PASSWORD ausente ou curta (mín. 12)'); process.exit(2); }

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const c = await pool.connect();
try {
  await c.query('begin');
  const hash = await hashPassword(password);
  const e = email.trim().toLowerCase();
  const u = await c.query(
    `insert into auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at)
     values ($1, $2, $3::jsonb, now())
     on conflict (lower(email)) do update set encrypted_password = excluded.encrypted_password, failed_attempts = 0, locked_until = null, updated_at = now()
     returning id`, [e, hash, JSON.stringify({ nome })]);
  const uid = u.rows[0].id;
  await c.query(`update public.profiles set nome = $2, tipo_user_geral = $3, status_user = 'Ativo' where auth_id = $1`, [uid, nome, papel]);
  if (papel === 'Cliente') {
    const has = await c.query(`select organization_id from public.profiles where auth_id = $1`, [uid]);
    if (!has.rows[0].organization_id) {
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'kobly_authenticated' })]);
      await c.query(`select public.create_own_org($1, $2)`, [org || `Loja ${nome}`, 'Teste']);
    }
  }
  await c.query('commit');
  const r = await c.query(`select p.tipo_user_geral, p.organization_id is not null as tem_org from public.profiles p where p.auth_id = $1`, [uid]);
  console.log(JSON.stringify({ email: e, ...r.rows[0] }));
} catch (err) { await c.query('rollback'); console.error('falhou:', err.message); process.exit(1); } finally { c.release(); await pool.end(); }
