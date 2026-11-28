import pg from 'pg';
import { env } from '../config/env.js';

export function createPool(connectionString = env.DATABASE_URL) {
  return new pg.Pool({
    connectionString,
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000
  });
}

export const pool = createPool();

export async function withPoolTransaction(callback, activePool = pool) {
  const client = await activePool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[db] transaction rollback failed:', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}
