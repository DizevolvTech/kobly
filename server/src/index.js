import pg from 'pg';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
const { server } = createApp({ pool, config });
server.listen(config.port, config.host, () => console.log(`[kobly-api] ouvindo em ${config.host}:${config.port}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
