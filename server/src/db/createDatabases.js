import pg from 'pg';
import { env } from '../config/env.js';

function databaseNameFromUrl(value) {
  const name = new URL(value).pathname.replace(/^\//, '');
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe database name in connection URL: ${name}`);
  }
  return name;
}

function maintenanceUrl() {
  const url = new URL(env.DATABASE_URL);
  url.pathname = '/postgres';
  return url.toString();
}

export async function createDatabases() {
  const names = [databaseNameFromUrl(env.DATABASE_URL)];
  if (env.TEST_DATABASE_URL) {
    const testName = databaseNameFromUrl(env.TEST_DATABASE_URL);
    if (!names.includes(testName)) names.push(testName);
  }

  const client = new pg.Client({ connectionString: maintenanceUrl() });
  const results = [];

  try {
    await client.connect();
    for (const name of names) {
      const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (existing.rowCount === 0) {
        await client.query(`CREATE DATABASE "${name}"`);
        results.push({ name, status: 'created' });
      } else {
        results.push({ name, status: 'already-exists' });
      }
    }
  } finally {
    await client.end();
  }

  return results;
}

if (process.argv[1] && /[\\/]createDatabases\.js$/.test(process.argv[1])) {
  createDatabases()
    .then((results) => {
      for (const result of results) {
        console.log(`[db:create] ${result.status}: ${result.name}`);
      }
    })
    .catch((error) => {
      console.error('[db:create] failed:', error.message || String(error));
      process.exitCode = 1;
    });
}
