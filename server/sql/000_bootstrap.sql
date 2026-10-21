-- Kobly no dize-db — bootstrap (rodar UMA vez como superusuário, no banco do projeto).
-- Recria o mínimo que o Supabase oferecia e que as migrações assumem:
-- papéis de API, schemas auth/extensions/vault/cron/net e as funções auth.uid()/role()/jwt().
-- Placeholders: :writer (papel dono dos objetos) e :authenticator (papel de login do PostgREST).
\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'kobly_anon') then
    create role kobly_anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'kobly_authenticated') then
    create role kobly_authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'kobly_service_role') then
    create role kobly_service_role nologin noinherit bypassrls;
  end if;
end $$;

grant kobly_anon, kobly_authenticated, kobly_service_role to :"authenticator";

create schema if not exists extensions authorization :"writer";
create schema if not exists auth authorization :"writer";
create schema if not exists vault authorization :"writer";
create schema if not exists cron authorization :"writer";
create schema if not exists net authorization :"writer";

create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists moddatetime with schema extensions;

grant usage on schema extensions to :"writer", kobly_anon, kobly_authenticated, kobly_service_role;
grant usage on schema auth to kobly_anon, kobly_authenticated, kobly_service_role;
grant create on schema public to :"writer";
grant usage on schema public to kobly_anon, kobly_authenticated, kobly_service_role;

alter database :"dbname" set search_path to "$user", public, extensions;

-- ---------------------------------------------------------------------------
-- auth: usuários próprios (login por e-mail/senha tratado pelo serviço kobly-api)
-- ---------------------------------------------------------------------------
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  encrypted_password text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  banned_until timestamptz,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists auth_users_email_key on auth.users (lower(email));
alter table auth.users owner to :"writer";

create table if not exists auth.sessions (
  token_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists auth_sessions_user on auth.sessions (user_id);
alter table auth.sessions owner to :"writer";

create table if not exists auth.one_time_tokens (
  token_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null check (purpose in ('recovery','confirm','invite')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table auth.one_time_tokens owner to :"writer";

create or replace function auth.jwt() returns jsonb
  language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;
create or replace function auth.uid() returns uuid
  language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create or replace function auth.role() returns text
  language sql stable as $$
  select nullif(auth.jwt() ->> 'role', '')
$$;
alter function auth.jwt() owner to :"writer";
alter function auth.uid() owner to :"writer";
alter function auth.role() owner to :"writer";
grant execute on function auth.jwt(), auth.uid(), auth.role() to kobly_anon, kobly_authenticated, kobly_service_role;

-- ---------------------------------------------------------------------------
-- vault: só para flags internas (chaves de provedores ficam no ambiente do serviço)
-- ---------------------------------------------------------------------------
create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text,
  secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table vault.secrets owner to :"writer";
create or replace view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, created_at, updated_at from vault.secrets;
alter view vault.decrypted_secrets owner to :"writer";
create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
  returns uuid language sql as $$
  insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id
$$;
create or replace function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null)
  returns void language sql as $$
  update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
         description = coalesce(new_description, description), updated_at = now() where id = secret_id
$$;
alter function vault.create_secret(text, text, text) owner to :"writer";
alter function vault.update_secret(uuid, text, text, text) owner to :"writer";

-- ---------------------------------------------------------------------------
-- cron / net: o agendamento e as chamadas HTTP passam a ser do serviço kobly-api.
-- As migrações só registram o intento; o serviço lê cron.job e executa.
-- ---------------------------------------------------------------------------
create table if not exists cron.job (
  jobid bigserial primary key,
  jobname text unique,
  schedule text not null,
  command text not null,
  active boolean not null default true
);
alter table cron.job owner to :"writer";
create or replace function cron.schedule(job_name text, schedule text, command text)
  returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;
alter function cron.schedule(text, text, text) owner to :"writer";
create or replace function net.http_post(url text, headers jsonb default '{}'::jsonb, body jsonb default '{}'::jsonb)
  returns bigint language sql as $$ select 0::bigint $$;
alter function net.http_post(text, jsonb, jsonb) owner to :"writer";
