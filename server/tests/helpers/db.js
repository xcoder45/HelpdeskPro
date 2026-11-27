import { randomUUID } from 'node:crypto';
import { pool } from '../../src/db/pool.js';

export async function resetDatabase() {
  await pool.query(`
    TRUNCATE TABLE
      audit_logs, attachments, ticket_history, comments, tickets,
      subcategories, categories, sla_rules, user_sessions, auth_tokens,
      users, roles
    RESTART IDENTITY CASCADE
  `);
  await pool.query('ALTER SEQUENCE ticket_code_seq RESTART WITH 1');
}

export async function createUser({ email = `user-${randomUUID()}@example.com`, role = 'employee' } = {}) {
  const { rows: roleRows } = await pool.query('SELECT id FROM roles WHERE name = $1', [role]);
  if (roleRows.length === 0) throw new Error(`Role not seeded: ${role}`);
  const { rows } = await pool.query(
    `INSERT INTO users (first_name, last_name, email, password_hash, role_id)
     VALUES ('Test', 'User', $1, $2, $3) RETURNING id, email`,
    [email, 'x'.repeat(60), roleRows[0].id]
  );
  return rows[0];
}

export async function createTicket(overrides = {}) {
  const requesterId = overrides.requesterId ?? (await createUser({ role: 'employee' })).id;
  const { rows: categories } = await pool.query("SELECT id FROM categories WHERE name = 'Hardware'");
  const { rows: subcategories } = await pool.query("SELECT id FROM subcategories WHERE name = 'Laptop / Desktop'");
  const { rows: rules } = await pool.query("SELECT id FROM sla_rules WHERE priority = 'High'");

  const { rows } = await pool.query(
    `INSERT INTO tickets (
       title, description, category_id, subcategory_id, priority, status,
       requester_id, sla_rule_id, response_due_at, resolved_at, resolution_notes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      overrides.title ?? 'Test incident about a workstation',
      overrides.description ?? 'Detailed description of the incident for testing.',
      categories[0].id,
      subcategories[0].id,
      overrides.priority ?? 'High',
      overrides.status ?? 'New',
      requesterId,
      rules[0].id,
      overrides.responseDueAt ?? new Date(Date.now() + 60 * 60_000),
      overrides.resolvedAt ?? null,
      overrides.resolutionNotes ?? null
    ]
  );
  return rows[0];
}
