import bcrypt from 'bcryptjs';
import { conflict, notFoundError } from '../../utils/errors.js';

const USER_SELECT = `
  SELECT u.*, r.name AS role
  FROM users u
  JOIN roles r ON r.id = u.role_id
`;

export function formatUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    role: row.role,
    isActive: Boolean(row.is_active),
    isDemo: Boolean(row.is_demo),
    emailVerifiedAt: row.email_verified_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function findUserByEmail(database, email) {
  const { rows } = await database.query(
    `${USER_SELECT} WHERE lower(u.email) = lower($1)`,
    [email]
  );
  return rows[0] ?? null;
}

export async function findUserById(database, id) {
  const { rows } = await database.query(`${USER_SELECT} WHERE u.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function createUserRecord(database, input) {
  const roleResult = await database.query('SELECT id FROM roles WHERE name = $1', [input.role]);
  if (roleResult.rowCount === 0) throw notFoundError('Role not found');

  const passwordHash = await bcrypt.hash(input.password, 12);
  try {
    const inserted = await database.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, role_id, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
      [input.firstName, input.lastName, input.email, passwordHash, roleResult.rows[0].id]
    );
    return formatUser(await findUserById(database, inserted.rows[0].id));
  } catch (error) {
    if (error.code === '23505') throw conflict('Email address is already in use');
    throw error;
  }
}

export async function updateUserRecord(database, id, changes) {
  const columns = {
    firstName: 'first_name',
    lastName: 'last_name',
    email: 'email',
    role: 'role_id',
    isActive: 'is_active'
  };
  const values = [];
  const assignments = [];
  let emailChanged = false;

  if ('email' in changes) {
    const current = await findUserById(database, id);
    emailChanged = !current
      || String(current.email).toLowerCase() !== String(changes.email).trim().toLowerCase();
    if (emailChanged) {
      changes.email = String(changes.email).trim();
    }
  }

  for (const [key, column] of Object.entries(columns)) {
    if (!(key in changes)) continue;
    let value = changes[key];
    if (key === 'role') {
      const roleResult = await database.query('SELECT id FROM roles WHERE name = $1', [value]);
      if (roleResult.rowCount === 0) throw notFoundError('Role not found');
      value = roleResult.rows[0].id;
    }
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  if (emailChanged) assignments.push('email_verified_at = NULL');

  if (assignments.length === 0) {
    return formatUser(await findUserById(database, id));
  }

  values.push(id);
  const idParameter = values.length;
  try {
    const updated = await database.query(
      `UPDATE users SET ${assignments.join(', ')} WHERE id = $${idParameter} RETURNING id`,
      values
    );
    if (updated.rowCount === 0) throw notFoundError('User not found');
    if (emailChanged) {
      await database.query(
        `UPDATE auth_tokens SET used_at = now()
         WHERE user_id = $1 AND purpose = 'email_verification' AND used_at IS NULL`,
        [id]
      );
    }
    return formatUser(await findUserById(database, id));
  } catch (error) {
    if (error.code === '23505') throw conflict('Email address is already in use');
    throw error;
  }
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

export async function listUsers(database, { page, limit, search, role, isActive, sort, order }) {
  const conditions = ['1 = 1'];
  const values = [];

  if (search) {
    values.push(`%${escapeLike(search)}%`);
    const parameter = `$${values.length}`;
    conditions.push(`(
      u.first_name ILIKE ${parameter} ESCAPE '\\'
      OR u.last_name ILIKE ${parameter} ESCAPE '\\'
      OR u.email ILIKE ${parameter} ESCAPE '\\'
    )`);
  }

  if (role) {
    values.push(role);
    conditions.push(`r.name = $${values.length}`);
  }

  if (isActive !== undefined) {
    values.push(isActive);
    conditions.push(`u.is_active = $${values.length}`);
  }

  const where = conditions.join(' AND ');
  const countResult = await database.query(
    `SELECT count(*)::int AS total
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE ${where}`,
    values
  );

  const sortColumns = {
    createdAt: 'u.created_at',
    name: 'u.first_name',
    email: 'u.email',
    role: 'r.name'
  };
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const offset = (page - 1) * limit;
  values.push(limit, offset);

  const rows = await database.query(
    `${USER_SELECT}
     WHERE ${where}
     ORDER BY ${sortColumns[sort]} ${direction}, u.id DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );

  return {
    users: rows.rows.map(formatUser),
    total: countResult.rows[0].total
  };
}
