import bcrypt from 'bcryptjs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedReferenceData } from '../../src/db/seed.js';
import { seedDemoData } from '../../src/db/seedDemo.js';
import { createUser, resetDatabase } from '../helpers/db.js';

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDatabase();
  await seedReferenceData(pool, { includeBootstrapUsers: false });
});

describe('reference seed', () => {
  it('loads roles, SLA rules and the incident category catalogue idempotently', async () => {
    const first = await seedReferenceData(pool, { includeBootstrapUsers: false });
    const second = await seedReferenceData(pool, { includeBootstrapUsers: false });

    expect(first.categoriesInserted).toBe(0);
    expect(first.subcategoriesInserted).toBe(0);
    expect(second.categoriesInserted).toBe(0);
    expect(second.subcategoriesInserted).toBe(0);

    const { rowCount: categoryCount } = await pool.query('SELECT 1 FROM categories');
    const { rowCount: subcategoryCount } = await pool.query('SELECT 1 FROM subcategories');
    expect(categoryCount).toBe(6);
    expect(subcategoryCount).toBe(16);

    const { rows: rules } = await pool.query('SELECT priority, response_minutes FROM sla_rules ORDER BY priority');
    expect(rules).toEqual([
      { priority: 'Critical', response_minutes: 60 },
      { priority: 'High', response_minutes: 240 },
      { priority: 'Low', response_minutes: 1440 },
      { priority: 'Medium', response_minutes: 480 }
    ]);
  });

  it('hashes bootstrap passwords and does not duplicate bootstrap users', async () => {
    await seedReferenceData(pool);
    const { rows } = await pool.query(
      "SELECT email, password_hash FROM users WHERE email = 'admin@helpdesk.local'"
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].password_hash).not.toBe('ChangeMe123!');
    expect(await bcrypt.compare('ChangeMe123!', rows[0].password_hash)).toBe(true);

    const second = await seedReferenceData(pool);
    expect(second.usersInserted).toBe(0);
    const { rowCount } = await pool.query('SELECT 1 FROM users');
    expect(rowCount).toBe(3);
  });
});

describe('optional demo dataset', () => {
  it('inserts clearly labelled tickets with real deadlines and is idempotent', async () => {
    const result = await seedDemoData(pool);
    expect(result).toMatchObject({ status: 'seeded', tickets: 8, labelled: true });

    const { rows } = await pool.query(`
      SELECT ticket_code, is_demo, priority, response_due_at, first_responded_at,
             created_at, resolved_at, status, resolution_notes
      FROM tickets
    `);
    const { rows: rules } = await pool.query('SELECT priority, response_minutes FROM sla_rules');
    const ruleMinutes = new Map(rules.map((rule) => [rule.priority, rule.response_minutes]));

    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.is_demo)).toBe(true);
    expect(rows.every((row) => row.ticket_code.startsWith('HD-'))).toBe(true);
    expect(rows.every((row) => row.response_due_at instanceof Date)).toBe(true);

    for (const row of rows) {
      const createdAt = new Date(row.created_at).getTime();
      const expectedDueAt = new Date(createdAt + ruleMinutes.get(row.priority) * 60_000);
      expect(new Date(row.response_due_at).toISOString()).toBe(expectedDueAt.toISOString());
      if (row.first_responded_at) {
        expect(new Date(row.first_responded_at).getTime()).toBeGreaterThanOrEqual(createdAt);
      }
      if (row.resolved_at) {
        expect(new Date(row.resolved_at).getTime()).toBeGreaterThanOrEqual(createdAt);
      }
    }

    const overdueWithoutResponse = rows.some((row) =>
      new Date(row.response_due_at) < new Date() && row.first_responded_at === null
    );
    expect(overdueWithoutResponse).toBe(true);

    const { rows: earlyComments } = await pool.query(`
      SELECT 1 FROM comments c
      JOIN tickets t ON t.id = c.ticket_id
      WHERE t.is_demo AND c.created_at < t.created_at
    `);
    expect(earlyComments).toHaveLength(0);

    const { rows: internalNotes } = await pool.query('SELECT 1 FROM comments WHERE is_internal');
    expect(internalNotes.length).toBeGreaterThan(0);

    const second = await seedDemoData(pool);
    expect(second.status).toBe('skipped');
  });

  it('records closed demo tickets as resolved before they were closed', async () => {
    await seedDemoData(pool);
    const { rows: closed } = await pool.query(`
      SELECT id, resolved_at, closed_at FROM tickets
      WHERE is_demo = true AND status = 'Closed'
    `);
    expect(closed.length).toBeGreaterThan(0);

    for (const ticket of closed) {
      const { rows: history } = await pool.query(
        `SELECT old_value, new_value FROM ticket_history
         WHERE ticket_id = $1 AND action = 'status_changed'
         ORDER BY created_at ASC`,
        [ticket.id]
      );
      expect(history).toMatchObject([
        { old_value: 'New', new_value: 'Resolved' },
        { old_value: 'Resolved', new_value: 'Closed' }
      ]);
    }
  });

  it('handles a pre-existing demo user whose email differs only by case', async () => {
    await createUser({ email: 'DEMO.AGENT@helpdesk.local', role: 'agent' });
    const result = await seedDemoData(pool);
    expect(result).toMatchObject({ status: 'seeded', tickets: 8 });
    const { rows } = await pool.query(
      "SELECT email FROM users WHERE lower(email) = 'demo.agent@helpdesk.local'"
    );
    expect(rows).toHaveLength(1);
  });
});
