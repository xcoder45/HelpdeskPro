import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../../src/db/pool.js';

export async function createTestUser({
  email = `user-${randomUUID()}@example.com`,
  password = 'TestPassword123!',
  role = 'employee',
  firstName = 'Test',
  lastName = 'User'
} = {}) {
  const { rows: roleRows } = await pool.query('SELECT id FROM roles WHERE name = $1', [role]);
  if (roleRows.length === 0) throw new Error(`Role not seeded: ${role}`);

  const passwordHash = await bcrypt.hash(password, 4);
  const { rows } = await pool.query(
    `INSERT INTO users (first_name, last_name, email, password_hash, role_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [firstName, lastName, email, passwordHash, roleRows[0].id]
  );

  return {
    id: Number(rows[0].id),
    email,
    password,
    role,
    firstName,
    lastName
  };
}
