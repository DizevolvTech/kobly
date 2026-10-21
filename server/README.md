# kobly-api (dize-db)

Substitui o Supabase do Kobly por: Postgres no dize-db + PostgREST (mesma API de tabelas que o front já usa)
+ este serviço (login/sessões; depois, as rotas que eram Edge Functions).

## Peças
- `sql/000_bootstrap.sql` (em `server/sql/`): papéis `kobly_anon|authenticated|service_role`, schemas `auth`, `vault`, `cron`, `net`, `extensions`, e `auth.uid()/jwt()/role()` lendo `request.jwt.claims` (o PostgREST preenche).
- `tools/build-schema.mjs`: gera o esquema a partir de `supabase/migrations/` (troca os nomes dos papéis; **exclui a 0013**, que criava usuários demo com senha publicada) + `900_grants.sql`.
- `src/`: login (PBKDF2 100k), JWT HS256 de 1 h, refresh rotativo de 30 dias (só o SHA-256 fica no banco), trava de conta após 5 falhas, limite por IP, recuperação de senha de uso único.
- `tools/create-user.mjs`: cria usuário de teste/operação (senha vem de `KOBLY_NEW_PASSWORD`, nunca de argumento).

## Rotas
`/rest/v1/*` → PostgREST (RLS por JWT); `/functions/v1/<nome>` → rotas que eram Edge Functions (501 `not_ported` até serem portadas); tempo real do chat = consulta periódica no cliente.
`POST /auth/login|signup|refresh|logout|recover|reset|confirm|password`, `GET /auth/user`, `GET /health`.

## Testes
`npm test` (unitários sempre; integração só com `KOBLY_TEST_DATABASE_URL` apontando para um Postgres **descartável** com o esquema aplicado).

## Estado
Etapa 1 (banco + login) e Etapa 2 (front ligado: `src/api/apiClient.js`) prontas em desenvolvimento (`https://kobly-api-dev.dizevolv.com`). Ainda 501: ai-chat, send-email, send-whatsapp (substituído pela rota whatsapp-account; envio das campanhas depende do motor), send-sms, bulk-send, asaas, resend-admin, invite-client, webhooks de entrada e agendador. `cron.schedule`/`net.http_post` são stubs: o agendador (process-steps, process-bulk, reset de uso) passa a ser do serviço.

## WhatsApp oficial (Meta Cloud API) — uma conta por empresa
- Cada empresa conecta o PRÓPRIO número (tela Integrações → WhatsApp): ID da conta WhatsApp Business, ID do número e token permanente. O serviço confere na Meta antes de salvar.
- Token e segredo do app ficam **cifrados** (AES-256-GCM, chave `KOBLY_SECRET_KEY` no ambiente do serviço) em `whatsapp_accounts`; o cliente só lê as colunas seguras (grant por coluna) e não escreve direto.
- Só modelos **aprovados** pela Meta iniciam conversa: `whatsapp_templates` (sincronizar/criar pela tela; status atualiza por webhook).
- Webhook por empresa: `GET/POST /webhooks/whatsapp/<id>` — verificação por token, POST validado por `X-Hub-Signature-256` (segredo do app da empresa, ou `META_APP_SECRET` global). Grava entregue/lido/falha em `email_events` e trata "SAIR" como descadastro (`leads.whatsapp_opt_out`).
- Rota: `POST /functions/v1/whatsapp-account` com `action` = status | connect | disconnect | sync_templates | create_template | send_test.
- Variáveis de ambiente: `KOBLY_SECRET_KEY` (32 bytes base64), `PUBLIC_BASE_URL`, `POSTGREST_URL`, opcionais `META_APP_SECRET`, `META_GRAPH_BASE`.
- O usuário do banco do serviço precisa poder `set role kobly_authenticated` (o `000_bootstrap.sql` concede ao :writer; o serviço checa isso ao subir).
