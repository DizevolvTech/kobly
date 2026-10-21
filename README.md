# Koblay — Console (Vite + React + Supabase)

Console operacional de **automação de recuperação de vendas** (koblay.io): campanhas por
e-mail e WhatsApp disparadas por eventos de checkout (abandono de carrinho, Pix/boleto
gerado, compra aprovada…), com construtor visual de fluxos, IA integrada e chat de suporte.

> Backend **100% real** em Supabase (Postgres + RLS multi-tenant + Edge Functions + Realtime).
> O nome `mockApi.js` é legado — a camada lê/escreve no Supabase de verdade.

## Stack
- **Vite 5** + **React 18** (JSX automático) · alias `@` → `src/`
- **Supabase** (`@supabase/supabase-js`): Auth, Postgres/RLS, Edge Functions (Deno), Realtime, Storage
- **lucide-react** (ícones) · **apexcharts** (gráficos)
- CSS com design tokens (custom properties) — sem framework de UI. Tema dark "Carvão Quente".
- IA: DeepSeek via Edge Function `ai-chat` (chave no Vault, nunca no browser)
- E-mail via **Resend** · WhatsApp via **Z-API** (credenciais no Vault)

## Scripts
```bash
npm install      # dependências
npm run dev      # servidor de desenvolvimento (http://localhost:5173)
npm run build    # build de produção -> dist/
npm run preview  # serve o build
npm test         # testes de interface/regras (vitest, sem rede nem banco)
npm run gen:icons  # regenera src/ds/iconRegistry.js ao usar um ícone Lucide novo
```
Testes das Edge Functions: `cd supabase/functions/_shared && deno test --no-lock -A`.
O CI (`.github/workflows/ci.yml`) roda os dois + o build a cada PR e push na `main`.

## Variáveis de ambiente
```
VITE_API_URL=   # URL da API do Kobly (dize-db), ex.: https://kobly-api-dev.dizevolv.com
```
O build **exige** a variável. Em DEV, sem ela, usa o proxy `/api` (defina `VITE_API_PROXY` com o destino).
O backend agora é o `server/` (ver `server/README.md`); o front não usa mais o `@supabase/supabase-js`.

## Papéis e rotas
| Papel | Home | Nav |
|---|---|---|
| **Cliente** | Dashboard | painel · pipeline · campanhas · leads · integrações · planos · chamados · ajuda · perfil |
| **Gestor** (agência) | Dashboard | + clientes · relatórios (visão multi-conta) |
| **Suporte** | Chamados | chamados · leads · ajuda · perfil |
| **Administrador** | Dashboard | painel · clientes · relatórios · planos · segurança · chamados · perfil |

Cadastro self-service: signup → confirmação de e-mail → onboarding cria a organização
(RPC `create_own_org`, plano Starter). RLS isola tudo por `organization_id`.

## Chat de suporte
Widget flutuante global (FAB "Suporte") com 3 modos: **IA** (task `support` da edge
`ai-chat`, com contexto real do usuário), **escalação** (abre chamado anexando a
transcrição como `autor='sistema'`) e **humano** (thread em tempo real). A tela
**Chamados** é o console do atendente (fila cross-tenant, filtros, atribuição, resolver).
Realtime: um canal por sessão em `support_messages`/`support_conversations` — a RLS
(WALRUS) filtra por JWT. Não-lidas via `cliente_last_read_at`/`support_last_read_at`.

## Estrutura
```
src/
  main.jsx            # entry — ErrorBoundary raiz + <App/>
  App.jsx             # KoblyStoreProvider + Shell
  ds/                 # DESIGN SYSTEM — import { Card, Button, ... } from '@/ds'
                      # Icon, Avatar, Badge, Banner, Button, Card, Checklist, DataTable,
                      # IconButton, Input, MetricCard, NavButton, NavRail, PageHeader,
                      # Select, Spinner, StatusLine, Tabs, TemplateCard, Tooltip
  lib/                # ui.jsx (skeletons/EmptyState/ErrorState/Toast/Drawer/Modal/PhoneField)
                      # hooks.jsx (useAsync/PageIntro) · motion.jsx (Reveal) ·
                      # charts.jsx (ApexCharts) · responsive.jsx (useBreakpoint) · emailTemplate.js
  api/                # camada de dados (Supabase): supabaseClient, supabaseDb (hidratação),
                      # mockApi (KoblyApi — contrato da UI), ai.js (KoblyAI), demoPersonas (DEV)
  store/store.jsx     # fases loading|login|recovery|onboarding|app · RBAC · toast
  shell/              # AppShell (rail responsivo + boundary por rota) · Topbar · Login ·
                      # Onboarding · SupportProvider (Realtime) · SupportWidget · ErrorBoundary
  routes/             # Dashboard, Pipeline, Campaigns(+FlowBuilder/EmailEditor), Leads,
                      # Integrations, Reports, Plans, Security, Clients, Tickets, Help, Profile
  styles/             # tokens/ (colors·typography·spacing·effects) + components.css + global.css
supabase/
  migrations/         # 0001–0027 (schema, RLS, seeds, chat de suporte, hardening)
  functions/          # ai-chat · send-email · send-whatsapp · webhook-receiver ·
                      # postback-receiver · process-steps · resend-admin · resend-webhook · zapi-webhook
docs/                 # especificação histórica da migração (referência)
```

## Deploy (Netlify)
`netlify.toml` já configura build (`dist/`, Node 20) e SPA fallback. Checklist de go-live:
1. Envs `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` no Netlify; domínio `app.koblay.io`.
2. Supabase Auth: Site URL/Redirect URLs = domínio final; ativar *leaked password protection*;
   SMTP custom (Resend) e templates de e-mail com a marca.
3. Vault: `deepseek_api_key`, `resend_api_key`, `resend_from` (domínio verificado — o fallback
   `onboarding@resend.dev` não serve para produção) e credenciais Z-API.
4. **Rotacionar/remover as personas demo** (`*@kobly.com`, senha publicada no repo — a seed
   0013 cria até um Administrador). `signInAsRole` já é DEV-only, mas os usuários existem no banco.
5. Webhooks: Resend → `resend-webhook`; Z-API (status) → `zapi-webhook`; cron do `process-steps` ativo.
6. Smoke test das 4 personas + fluxo de signup completo.

## Notas
- **Bundle**: telas carregadas sob demanda (`React.lazy`), ApexCharts por `import()` e ícones
  num registro estático (`src/ds/iconRegistry.js`, gerado). Carga inicial ~158 KB gzip
  (era ~478 KB).
- Telas/shell exportam nomes `Kobly*` (ex.: `KoblyDashboard`) — herdado do protótipo; renomeável.
