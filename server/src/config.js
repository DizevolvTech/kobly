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
  };
}
