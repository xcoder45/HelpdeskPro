import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { durationToMs } from '../../utils/cookies.js';
import { conflict, unauthorized } from '../../utils/errors.js';
import { findUserByEmail, formatUser } from '../users/service.js';
import { createAuthToken, hashToken } from './lifecycle.js';

// A real hash of an unused password keeps missing-account checks comparable in cost.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-equalisation-value', 12);

export function signAccessToken(user, tokenVersion = 0, jti) {
  const payload = { sub: String(user.id), ver: Number(tokenVersion) || 0 };
  if (jti) payload.jti = jti;
  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_EXPIRES_IN
  });
}

export async function issueSession(database, userRow, meta = {}) {
  const jti = randomUUID();
  const token = signAccessToken(userRow, userRow.token_version, jti);
  const expiresAt = new Date(Date.now() + durationToMs(env.JWT_EXPIRES_IN));
  const userAgent = typeof meta.userAgent === 'string' ? meta.userAgent.slice(0, 500) : null;

  await database.query(
    `INSERT INTO user_sessions (user_id, jti, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userRow.id, jti, hashToken(token), expiresAt, meta.ipAddress ?? null, userAgent]
  );

  return { token, jti, expiresAt };
}

export async function registerEmployee(database, input, meta = {}) {
  const roleResult = await database.query("SELECT id FROM roles WHERE name = 'employee'");
  if (roleResult.rowCount === 0) throw new Error('Employee role is missing from the database');

  const passwordHash = await bcrypt.hash(input.password, 12);
  const requiresVerification = env.REQUIRE_EMAIL_VERIFICATION;
  try {
    const inserted = await database.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, role_id, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN NULL ELSE now() END) RETURNING id`,
      [
        input.firstName,
        input.lastName,
        input.email,
        passwordHash,
        roleResult.rows[0].id,
        requiresVerification
      ]
    );
    const { rows } = await database.query(
      `SELECT u.*, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [inserted.rows[0].id]
    );
    const row = rows[0];
    const user = formatUser(row);
    const verificationToken = await createAuthToken(database, {
      userId: row.id,
      purpose: 'email_verification',
      ttl: env.EMAIL_VERIFICATION_TTL,
      email: row.email
    });
    const session = requiresVerification
      ? null
      : await issueSession(database, row, meta);

    return {
      user,
      token: session?.token ?? null,
      jti: session?.jti ?? null,
      verificationToken,
      requiresVerification
    };
  } catch (error) {
    if (error.code === '23505') throw conflict('Email address is already registered');
    throw error;
  }
}

export async function authenticate(database, input, meta = {}) {
  const userRow = await findUserByEmail(database, input.email);
  const passwordIsValid = await bcrypt.compare(
    input.password,
    userRow?.password_hash ?? DUMMY_PASSWORD_HASH
  );

  if (!userRow || !userRow.is_active || !passwordIsValid) {
    throw unauthorized('Invalid email or password');
  }
  if (env.REQUIRE_EMAIL_VERIFICATION && !userRow.email_verified_at) {
    throw unauthorized('Please verify your email address before signing in');
  }

  const user = formatUser(userRow);
  const session = await issueSession(database, userRow, meta);
  return { user, token: session.token, jti: session.jti };
}
