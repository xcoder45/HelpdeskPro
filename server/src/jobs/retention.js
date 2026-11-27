import { env } from '../config/env.js';
import { pool } from '../db/pool.js';

let timer = null;
let running = null;

export async function runRetention(
  database = pool,
  {
    auditDays = env.AUDIT_RETENTION_DAYS,
    historyDays = env.TICKET_HISTORY_RETENTION_DAYS
  } = {}
) {
  const { rows } = await database.query(
    'SELECT purge_expired_activity($1, $2) AS result',
    [auditDays, historyDays]
  );
  await database.query('DELETE FROM user_sessions WHERE expires_at <= now()');
  await database.query('DELETE FROM auth_tokens WHERE expires_at <= now()');
  return rows[0].result;
}

function execute(database, label) {
  running = runRetention(database)
    .then((result) => {
      console.log(`[retention] ${label} purge complete`, result);
      return result;
    })
    .catch((error) => {
      console.error(`[retention] ${label} purge failed:`, error?.message ?? error);
    })
    .finally(() => {
      running = null;
    });
  return running;
}

export function startRetentionJob(database = pool) {
  if (!env.RETENTION_ENABLED) return null;

  execute(database, 'startup');
  timer = setInterval(() => execute(database, 'scheduled'), env.RETENTION_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

export function stopRetentionJob() {
  if (timer) clearInterval(timer);
  timer = null;
  return running ?? Promise.resolve();
}
