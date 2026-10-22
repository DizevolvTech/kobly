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

## Entrada de vendas e motor de disparos
- `POST /functions/v1/postback-receiver?token=pbk_…` (público; o token identifica a empresa). Aceita o contrato Kobly, Hotmart, NexoPayt e ENTITY. Evento desconhecido/sem e-mail → 200 + `webhook_dead_letter`; reentrega → 200 `deduped`; token inválido → 401. Cria/atualiza o lead, credita venda recuperada e enfileira os passos das campanhas **Ativas** cujo gatilho casa.
- Motor (`src/engine/steps.js`): a cada `ENGINE_INTERVAL_MS` (30 s; `ENGINE_ENABLED=false` desliga) pega passos vencidos com lease (`for update skip locked`), executa **WhatsApp por modelo aprovado** e tags; retry com backoff (4 tentativas), SAIR respeitado, condição comprou/não comprou, cota estornada ao desistir.
- E-mail e SMS ainda NÃO foram portados: seus passos ficam na fila, intocados.

## E-mails, convite e sessão
- `src/mailer.js`: e-mails da Kobly (confirmar cadastro, recuperar senha, convite) com a marca; Resend via `RESEND_API_KEY`/`MAIL_FROM`; links no `SITE_URL`. Ver `docs/ONBOARDING.md`.
- `POST /functions/v1/invite-client` (Administrador/Gestor da conta): cria o acesso do cliente (perfil Cliente, sem senha) e envia o link para definir a senha (7 dias, uso único). Não puxa para a conta quem já pertence a outra.
- Refresh token rotativo com tolerância de 60 s (`auth.sessions.rotated_at`; ambientes antigos rodam `sql/001_session_grace.sql`): se a resposta da renovação se perde, a pessoa não é deslogada.

## Logo, descadastro e link de pós-compra
- Logo: `POST /storage/v1/object/branding/<org>/<arquivo>` (login, só da própria conta, PNG/JPG/WEBP/GIF até 2 MB, tipo conferido pelo conteúdo) e `GET /storage/v1/object/public/branding/...`. Disco em `STORAGE_DIR` (padrão `/var/lib/kobly-storage`; no systemd, liberar com `ReadWritePaths`).
- Descadastro: `GET|POST /functions/v1/unsubscribe?token=` (GET só confirma; POST grava em `email_suppressions`; one-click RFC 8058). Token assinado com `UNSUBSCRIBE_SECRET` (ou derivado de `KOBLY_SECRET_KEY`). `signUnsubToken` fica pronto para o envio de e-mail usar.
- Migração `0068`: `brands.link_area_membros`. Em "Compra Aprovada", o `{{cta_link}}` do WhatsApp leva para esse link; nos demais eventos segue o link de recuperação.

## Dados de demonstração (só ambientes de teste)
`server/tools/seed_demo.sql` cria, para UMA empresa, marca, tags, e-mails, 5 campanhas com fluxo, leads, eventos de checkout e e-mails enviados/abertos/clicados dos últimos 30 dias. Idempotente (tudo marcado `seed-demo`; reexecutar recria). Uso: `psql -c "set role <writer>" -v org=<uuid> -v tamanho=80 -f seed_demo.sql`. Nunca rodar em produção de cliente.
