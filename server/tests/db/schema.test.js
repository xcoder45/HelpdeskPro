import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedReferenceData } from '../../src/db/seed.js';
import { createTicket, createUser, resetDatabase } from '../helpers/db.js';

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDatabase();
  await seedReferenceData(pool, { includeBootstrapUsers: false });
});

describe('database schema', () => {
  it('records every migration', async () => {
    const { rows } = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
    expect(rows.map((row) => row.filename)).toEqual([
      '001_initial_schema.sql',
      '002_indexes.sql',
      '003_append_only_guards.sql',
      '004_analytics_cancellation.sql',
      '005_session_revocation.sql',
      '006_repair_audit_and_cancellation.sql',
      '007_account_lifecycle.sql',
      '008_retention.sql',
      '009_lifecycle_integrity.sql',
      '010_retention_grant.sql',
      '011_append_only_least_privilege.sql',
      '012_retention_owner_privileges.sql'
    ]);
  });

  it('grants retention execution to the migration role', async () => {
    const { rows } = await pool.query(`
      SELECT has_function_privilege(
        current_user,
        'public.purge_expired_activity(integer, integer)',
        'EXECUTE'
      ) AS allowed
    `);
    expect(rows[0].allowed).toBe(true);
  });

  it('creates all required relational tables', async () => {
    const { rows } = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    const tables = rows.map((row) => row.table_name);
    expect(tables).toEqual(expect.arrayContaining([
      'users', 'roles', 'tickets', 'categories', 'subcategories',
      'comments', 'ticket_history', 'sla_rules', 'attachments', 'audit_logs',
      'user_sessions', 'auth_tokens'
    ]));
  });

  it('tracks cancellation separately from resolution timestamps', async () => {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'tickets' AND column_name = 'cancelled_at'
    `);
    expect(rows).toHaveLength(1);

    const { rows: indexes } = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'tickets' AND indexname = 'idx_tickets_resolved_at'
    `);
    expect(indexes).toHaveLength(1);
  });

  it('generates readable unique ticket IDs', async () => {
    const first = await createTicket();
    const second = await createTicket();
    expect(first.ticket_code).toMatch(/^HD-\d{6,}$/);
    expect(second.ticket_code).toMatch(/^HD-\d{6,}$/);
    expect(second.ticket_code).not.toBe(first.ticket_code);
  });

  it('rejects invalid priority, missing references and unresolved resolved tickets', async () => {
    await expect(createTicket({ priority: 'Urgent' })).rejects.toMatchObject({ code: '23514' });
    await expect(createTicket({ requesterId: 999_999 })).rejects.toMatchObject({ code: '23503' });
    await expect(createTicket({ status: 'Resolved' })).rejects.toMatchObject({ code: '23514' });
  });

  it('enforces case-insensitive unique email addresses', async () => {
    await createUser({ email: 'Case@Test.example' });
    await expect(createUser({ email: 'case@test.example' })).rejects.toMatchObject({ code: '23505' });
  });

  it('keeps ticket history and audit logs append-only', async () => {
    const ticket = await createTicket();
    await pool.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action) VALUES ($1, NULL, 'created')`,
      [ticket.id]
    );
    await pool.query(
      `INSERT INTO audit_logs (action, entity_type, entity_id) VALUES ('test', 'ticket', $1)`,
      [ticket.id]
    );

    await expect(pool.query("UPDATE ticket_history SET action = 'changed'"))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("DELETE FROM audit_logs")).rejects.toMatchObject({ code: '23514' });
  });

  it('does not let a non-retention role use the GUC bypass', async () => {
    const role = `hd_probe_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE ROLE ${role} NOLOGIN`);
    await pool.query("INSERT INTO audit_logs (action, entity_type) VALUES ('probe', 'test')");
    const client = await pool.connect();

    try {
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.audit_logs TO ${role}`);
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SET LOCAL helpdesk_pro.retention_purge = 'on'`);

      await expect(client.query('DELETE FROM audit_logs'))
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
      client.release();
      await pool.query(`REVOKE ALL ON public.audit_logs FROM ${role}`);
      await pool.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    }
  });

  it('purges only expired append-only rows through the retention function', async () => {
    const ticket = await createTicket();
    const cutoff = new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString();
    await pool.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, created_at)
       VALUES ($1, NULL, 'created', $2), ($1, NULL, 'created', now())`,
      [ticket.id, cutoff]
    );
    await pool.query(
      `INSERT INTO audit_logs (action, entity_type, entity_id, created_at)
       VALUES ('old', 'ticket', $1, $2), ('recent', 'ticket', $1, now())`,
      [ticket.id, cutoff]
    );

    const { rows } = await pool.query('SELECT purge_expired_activity(1, 1) AS result');
    expect(rows[0].result).toMatchObject({ auditLogsDeleted: 1, ticketHistoryDeleted: 1 });

    const { rows: remaining } = await pool.query(`
      SELECT 'history' AS source, action FROM ticket_history WHERE ticket_id = $1
      UNION ALL
      SELECT 'audit' AS source, action FROM audit_logs WHERE entity_id = $1
    `, [ticket.id]);
    expect(remaining.map((row) => row.action).sort()).toEqual(['created', 'recent']);

    await expect(pool.query("DELETE FROM audit_logs WHERE action = 'recent'"))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('lets a non-superuser app role purge only through the retention function', async () => {
    const role = `hd_caller_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE ROLE ${role} NOLOGIN`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await pool.query(`GRANT EXECUTE ON FUNCTION public.purge_expired_activity(integer, integer) TO ${role}`);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      const { rows } = await client.query('SELECT purge_expired_activity(1, 1) AS result');
      expect(rows[0].result).toMatchObject({
        auditLogsDeleted: expect.any(Number),
        ticketHistoryDeleted: expect.any(Number)
      });
      await expect(client.query('DELETE FROM audit_logs')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
      client.release();
      await pool.query(`REVOKE EXECUTE ON FUNCTION public.purge_expired_activity(integer, integer) FROM ${role}`);
      await pool.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    }
  });

  it('allows ON DELETE SET NULL for append-only actor references', async () => {
    const ticket = await createTicket();
    const actor = await createUser({ role: 'agent' });
    await pool.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action) VALUES ($1, $2, 'assigned')`,
      [ticket.id, actor.id]
    );
    await pool.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
       VALUES ($1, 'test.action', 'ticket', $2)`,
      [actor.id, ticket.id]
    );

    await expect(pool.query('DELETE FROM users WHERE id = $1', [actor.id])).resolves.toBeDefined();

    const { rows: history } = await pool.query(
      'SELECT actor_id FROM ticket_history WHERE actor_id IS NULL AND action = $1',
      ['assigned']
    );
    const { rows: audit } = await pool.query(
      'SELECT actor_id FROM audit_logs WHERE actor_id IS NULL AND action = $1',
      ['test.action']
    );
    expect(history).toHaveLength(1);
    expect(audit).toHaveLength(1);
  });
});
