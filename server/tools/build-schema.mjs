// Gera o esquema do Kobly para o dize-db a partir de supabase/migrations/.
//   node server/tools/build-schema.mjs <pasta-de-saída>
// Transformações (todas mecânicas, sem mexer na lógica das migrações):
//  - papéis anon/authenticated/service_role -> kobly_anon/kobly_authenticated/kobly_service_role
//  - remove `create extension` de pg_cron/pg_net (viram stubs em 000_bootstrap.sql)
//  - exclui migrações que não valem aqui (EXCLUDE abaixo)
//  - acrescenta 900_grants.sql (o Supabase concedia privilégios de tabela por padrão)
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = process.argv[2];
if (!out) { console.error('uso: build-schema.mjs <saida>'); process.exit(2); }

// 0013 cria usuários demo com senha publicada no repositório: nunca entra.
const EXCLUDE = new Map([
  ['0013_seed_demo_auth_users.sql', 'usuários demo com senha publicada'],
]);

export function transform(sql) {
  let s = sql;
  s = s.replace(/^\s*create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;\s*$/gim, '-- (removido) create extension $1');
  s = s.replace(/\bservice_role\b/g, 'kobly_service_role');
  s = s.replace(/\banon\b/g, 'kobly_anon');
  s = s.replace(/\bauthenticated\b/g, 'kobly_authenticated');
  return s;
}

mkdirSync(out, { recursive: true });
const dir = join(root, 'supabase', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const manifest = [];
for (const f of files) {
  if (EXCLUDE.has(f)) { manifest.push({ file: f, skipped: EXCLUDE.get(f) }); continue; }
  const body = transform(readFileSync(join(dir, f), 'utf8'));
  writeFileSync(join(out, f), body);
  manifest.push({ file: f, sha256: createHash('sha256').update(body).digest('hex') });
}
const grants = `-- 900_grants.sql — privilégios de tabela/sequência (o Supabase concedia por padrão).
-- A RLS (ligada nas tabelas) é quem restringe linhas; aqui só se habilita o acesso aos objetos.
grant select, insert, update, delete on all tables in schema public to kobly_authenticated;
grant usage, select on all sequences in schema public to kobly_authenticated;
grant all on all tables in schema public to kobly_service_role;
grant all on all sequences in schema public to kobly_service_role;
grant select on all tables in schema public to kobly_anon;
`;
writeFileSync(join(out, '900_grants.sql'), grants);
manifest.push({ file: '900_grants.sql', sha256: createHash('sha256').update(grants).digest('hex') });
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`${manifest.filter((m) => m.sha256).length} arquivos, ${manifest.filter((m) => m.skipped).length} excluídos`);
