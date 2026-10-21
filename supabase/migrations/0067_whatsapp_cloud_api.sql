-- 0067_whatsapp_cloud_api.sql
-- Kobly — WhatsApp pela API oficial da Meta (Cloud API), uma conta POR ORGANIZAÇÃO.
-- Cada cliente conecta o próprio número/WABA; os disparos saem do WhatsApp dele.
-- Substitui o canal Z-API compartilhado (credenciais globais no Vault).
--
-- Segredos (token de acesso, app secret) ficam CIFRADOS (AES-256-GCM, chave no ambiente do
-- serviço) e NÃO são legíveis pelo cliente: a leitura da tabela é por coluna, só as seguras.
-- Toda escrita passa pelo serviço (rota whatsapp-account), que valida o número na Meta antes.

create table public.whatsapp_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  waba_id text not null,
  phone_number_id text not null,
  display_phone text,
  verified_name text,
  quality_rating text,
  messaging_limit text,
  status text not null default 'pending' check (status in ('pending', 'connected', 'error')),
  last_error text,
  -- webhook: a Meta chama /webhooks/whatsapp/<webhook_public_id>; verify_token confirma a inscrição
  webhook_public_id uuid not null unique default gen_random_uuid(),
  verify_token text not null,
  token_enc text not null,
  app_secret_enc text,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.whatsapp_accounts
  for each row execute function public.tg_set_updated_at();

alter table public.whatsapp_accounts enable row level security;
create policy whatsapp_accounts_select on public.whatsapp_accounts for select to authenticated
  using (public.has_org_access(organization_id));

-- sem escrita direta e sem leitura dos segredos
revoke all on public.whatsapp_accounts from authenticated, anon, public;
grant select (id, organization_id, waba_id, phone_number_id, display_phone, verified_name, quality_rating,
              messaging_limit, status, last_error, webhook_public_id, verify_token, connected_at, created_at, updated_at)
  on public.whatsapp_accounts to authenticated;

-- Modelos aprovados pela Meta (a API oficial só permite iniciar conversa com modelo aprovado)
create table public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  account_id uuid not null references public.whatsapp_accounts(id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9_]+$' and char_length(name) <= 512),
  language text not null,
  category text not null check (category in ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  status text not null default 'PENDING',
  meta_template_id text,
  components jsonb not null default '[]'::jsonb,
  body_text text,
  variable_count int not null default 0,
  rejected_reason text,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, name, language)
);
create trigger set_updated_at before update on public.whatsapp_templates
  for each row execute function public.tg_set_updated_at();
create index idx_whatsapp_templates_org on public.whatsapp_templates (organization_id);

alter table public.whatsapp_templates enable row level security;
create policy whatsapp_templates_select on public.whatsapp_templates for select to authenticated
  using (public.has_org_access(organization_id));
revoke all on public.whatsapp_templates from authenticated, anon, public;
grant select on public.whatsapp_templates to authenticated;

-- A mensagem de WhatsApp da campanha passa a apontar para um modelo + mapa das variáveis
-- ({{1}} → campo do lead: nome, produto, valor, cta_link…). O texto livre antigo vira rascunho.
alter table public.whatsapp_messages
  add column if not exists template_id uuid references public.whatsapp_templates(id) on delete set null,
  add column if not exists template_vars jsonb not null default '[]'::jsonb;
create index if not exists idx_whatsapp_messages_template on public.whatsapp_messages (template_id);

-- Consentimento: quem pediu para sair não recebe mais (a Meta penaliza o número).
alter table public.leads add column if not exists whatsapp_opt_out boolean not null default false;
