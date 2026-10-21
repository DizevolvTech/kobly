// Kobly — cliente de dados/autenticação do app.
//
// Fala com a API própria do Kobly (dize-db): /auth (login), /rest/v1 (PostgREST, mesma
// sintaxe de filtros do Supabase) e /functions/v1 (rotas que eram Edge Functions).
// Mantém o MESMO formato de uso do supabase-js (`supabase.from(...).select().eq()`,
// `supabase.auth.*`, `supabase.rpc`, `supabase.functions.invoke`, `supabase.channel`),
// então as telas e a camada de API não mudam. Detalhes em `./apiClient.js`.
//
// Variável de build: VITE_API_URL (ex.: https://kobly-api.exemplo.com). Em DEV, sem a variável,
// usa o proxy local do Vite (`/api`).
import { createApiClient } from './apiClient.js';

const RAW = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? '/api' : '');
if (!RAW) {
  throw new Error('Configuração ausente: defina VITE_API_URL no ambiente de build.');
}
const API_URL = RAW.replace(/\/$/, '');

// URL base — única fonte p/ montar URLs públicas (webhook/postback).
export const SUPABASE_URL = API_URL;
export const API_BASE_URL = API_URL;

export const supabase = createApiClient({ baseUrl: API_URL });
