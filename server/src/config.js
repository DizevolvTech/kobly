// Configuração só por variáveis de ambiente (nenhum segredo no repositório).
export function loadConfig(env = process.env) {
  const need = (k) => { if (!env[k]) throw new Error(`Variável ausente: ${k}`); return env[k]; };
  return {
    port: Number(env.PORT || 4120),
    host: env.HOST || '127.0.0.1',
    databaseUrl: need('DATABASE_URL'),
    jwtSecret: need('JWT_SECRET'),
    requireConfirm: env.REQUIRE_EMAIL_CONFIRM === 'true',
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === 'true',
    // Site público da Kobly (links dos e-mails). Sem SITE_URL, usa a primeira origem permitida.
    siteUrl: (env.SITE_URL || (env.ALLOWED_ORIGINS || '').split(',')[0] || '').trim().replace(/\/$/, ''),
    resendApiKey: env.RESEND_API_KEY || '',
    mailFrom: env.MAIL_FROM || 'Kobly <onboarding@resend.dev>',
    postgrestUrl: env.POSTGREST_URL || '',
    // WhatsApp (Meta): chave que cifra tokens dos clientes, URL pública p/ webhook, segredo do app Kobly (opcional)
    secretKey: env.KOBLY_SECRET_KEY || '',
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    metaAppSecret: env.META_APP_SECRET || '',
    metaGraphBase: env.META_GRAPH_BASE || 'https://graph.facebook.com/v21.0',
  };
}
