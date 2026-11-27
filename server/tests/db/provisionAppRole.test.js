import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, runMigrations } = vi.hoisted(() => ({
  query: vi.fn(),
  runMigrations: vi.fn()
}));

vi.mock('../../src/db/pool.js', () => ({ pool: { query, end: vi.fn() } }));
vi.mock('../../src/db/migrate.js', () => ({ runMigrations }));
vi.mock('../../src/config/env.js', () => ({
  env: { APP_DATABASE_USER: 'helpdesk_app', APP_DATABASE_PASSWORD: 'local_dev_change_me' }
}));

const { provisionAppRole } = await import('../../src/db/provisionAppRole.js');

describe('application database provisioning', () => {
  beforeEach(() => {
    query.mockReset();
    runMigrations.mockReset();
    query.mockResolvedValue({ rowCount: 0 });
    runMigrations.mockResolvedValue([]);
  });

  it('creates the least-privileged role and grants application rights', async () => {
    await provisionAppRole({ database: { query }, role: 'helpdesk_app', password: 'secret' });

    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements.some((sql) => sql.includes('CREATE ROLE helpdesk_app'))).toBe(true);
    expect(statements.some((sql) => sql.includes('REVOKE DELETE ON public.audit_logs, public.ticket_history FROM helpdesk_app'))).toBe(true);
    expect(statements.some((sql) => sql.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES'))).toBe(true);
    expect(runMigrations).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe role names before touching the database', async () => {
    await expect(provisionAppRole({ database: { query }, role: 'helpdesk_app; drop table users', password: 'secret' }))
      .rejects.toThrow(/safe role name/);
    expect(query).not.toHaveBeenCalled();
  });
});
