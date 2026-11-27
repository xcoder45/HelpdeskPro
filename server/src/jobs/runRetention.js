import { runRetention } from './retention.js';
import { pool } from '../db/pool.js';

try {
  const result = await runRetention(pool);
  console.log('[retention] purge complete', result);
} catch (error) {
  console.error('[retention] purge failed:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
