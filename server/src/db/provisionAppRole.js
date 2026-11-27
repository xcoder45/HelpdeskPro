import { env } from '../config/env.js';
import { pool } from './pool.js';
import { runMigrations } from './migrate.js';

const SAFE_ROLE = /^[a-z_][a-z0-9_]*$/;

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function provisionAppRole({
  database = pool,
  role = env.APP_DATABASE_USER,
  password = env.APP_DATABASE_PASSWORD
} = {}) {
  if (!SAFE_ROLE.test(role) || role === 'helpdesk_retention') {
    throw new Error('APP_DATABASE_USER must be a safe role name other than helpdesk_retention');
  }
  if (!password) throw new Error('APP_DATABASE_PASSWORD must be set');

  const existing = await database.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (existing.rowCount > 0) {
    await database.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(password)}`);
  } else {
    await database.query(`CREATE ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(password)}`);
  }

  await runMigrations();

  await database.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await database.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await database.query(`REVOKE DELETE ON public.audit_logs, public.ticket_history FROM ${role}`);
  await database.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await database.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);

  return { role, provisioned: true };
}

if (process.argv[1] && /[\\/]provisionAppRole\.js$/.test(process.argv[1])) {
  provisionAppRole()
    .then(({ role }) => console.log(`[provision] ${role} is ready`))
    .catch((error) => {
      console.error('[provision] failed:', error.message || String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
