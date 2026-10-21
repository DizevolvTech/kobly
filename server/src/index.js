import pg from 'pg';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
// Falha cedo (e claro) se o papel do banco não puder assumir kobly_authenticated — checagens de acesso dependem disso.
try {
  const c = await pool.connect();
  try { await c.query('begin'); await c.query('set local role kobly_authenticated'); await c.query('rollback'); } finally { c.release(); }
} catch (e) {
  console.error('[kobly-api] o usuário do banco não pode assumir kobly_authenticated:', e.message);
  process.exit(1);
}
const { server } = createApp({ pool, config });
server.listen(config.port, config.host, () => console.log(`[kobly-api] ouvindo em ${config.host}:${config.port}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
