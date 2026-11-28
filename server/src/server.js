import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { initializeDatabase } from './db/initialize.js';
import { startRetentionJob, stopRetentionJob } from './jobs/retention.js';
import { closeRateLimitStore } from './services/rateLimitStore.js';

let initialized = false;

try {
  const result = await initializeDatabase({ activePool: pool });
  initialized = true;
  if (result.migrations) console.log('[helpdesk-pro] migrations verified');
  if (result.seed) console.log('[helpdesk-pro] reference data verified');
} catch (error) {
  console.error('[helpdesk-pro] startup database initialization failed; server not started:', error?.message ?? error);
  try {
    await pool.end();
  } catch (cleanupError) {
    console.error('[helpdesk-pro] database cleanup failed:', cleanupError?.message ?? cleanupError);
  }
  process.exit(1);
}

if (initialized) {
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`[helpdesk-pro] server listening on http://127.0.0.1:${env.PORT}`);
  });

  startRetentionJob(pool);

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[helpdesk-pro] ${signal} received, shutting down`);

    const forcedExit = setTimeout(() => {
      console.warn('[helpdesk-pro] forced shutdown after timeout');
      process.exit(1);
    }, 15_000);
    forcedExit.unref?.();

    try {
      await stopRetentionJob();
      await new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeIdleConnections?.();
      });
      await closeRateLimitStore();
      await pool.end();
      clearTimeout(forcedExit);
      process.exit(0);
    } catch (error) {
      console.error('[helpdesk-pro] error closing resources:', error?.message ?? error);
      clearTimeout(forcedExit);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}
