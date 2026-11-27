import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { durationToMs } from '../../utils/cookies.js';
import { badRequest, notFoundError } from '../../utils/errors.js';
import { withTransaction } from '../../db/transaction.js';

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function hashEmail(email) {
  return hashToken(String(email).trim().toLowerCase());
}

export function createOpaqueToken() {
  return randomBytes(32).toString('hex');
}

export async function createAuthToken(database, { userId, purpose, ttl, email }) {
  const expiresAt = new Date(Date.now() + durationToMs(ttl));
  const emailHash = purpose === 'email_verification' && email ? hashEmail(email) : null;
  let lastConflict;

  // A unique partial index enforces one live link per user/purpose. If a
  // concurrent request wins the race, invalidate the winner and try again.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await database.query(
      `UPDATE auth_tokens SET used_at = now()
       WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
      [userId, purpose]
    );
    const token = createOpaqueToken();
    try {
      await database.query(
        `INSERT INTO auth_tokens (user_id, purpose, token_hash, email_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, purpose, hashToken(token), emailHash, expiresAt]
      );
      return token;
    } catch (error) {
      if (error.code !== '23505') throw error;
      lastConflict = error;
    }
  }
  throw lastConflict ?? new Error('Could not issue a lifecycle token');
}

export async function consumeAuthToken(database, { token, purpose }) {
  const { rows } = await database.query(
    `SELECT id, user_id, expires_at, used_at, email_hash
     FROM auth_tokens
     WHERE token_hash = $1 AND purpose = $2
     FOR UPDATE`,
    [hashToken(token), purpose]
  );
  const record = rows[0];
  if (!record || record.used_at || new Date(record.expires_at).getTime() <= Date.now()) {
    throw badRequest('This link is invalid or has expired');
  }
  if (purpose === 'email_verification') {
    const { rows: users } = await database.query('SELECT email FROM users WHERE id = $1', [record.user_id]);
    if (!users[0] || !record.email_hash || record.email_hash !== hashEmail(users[0].email)) {
      throw badRequest('This link is invalid or has expired');
    }
  }
  await database.query('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [record.id]);
  return Number(record.user_id);
}

export async function listSessions(database, userId, currentJti) {
  const { rows } = await database.query(
    `SELECT id, jti, ip_address, user_agent, created_at, expires_at, last_used_at, revoked_at
     FROM user_sessions
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC`,
    [userId]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    revoked: Boolean(row.revoked_at),
    current: row.jti === currentJti
  }));
}

export async function revokeSession(database, userId, sessionId) {
  const { rowCount } = await database.query(
    `UPDATE user_sessions SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [sessionId, userId]
  );
  if (rowCount === 0) throw notFoundError('Session not found');
}

export async function revokeOtherSessions(database, userId, currentJti) {
  const { rowCount } = await database.query(
    `UPDATE user_sessions SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL AND jti <> $2`,
    [userId, currentJti ?? '']
  );
  return rowCount;
}

export async function revokeAllSessions(database, userId) {
  await database.query(
    'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId]
  );
}

export async function resetPasswordWithClient(client, { token, password, ipAddress }) {
  const userId = await consumeAuthToken(client, { token, purpose: 'password_reset' });
  const passwordHash = await bcrypt.hash(password, 12);
  await client.query(
    'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2',
    [passwordHash, userId]
  );
  await revokeAllSessions(client, userId);
  return { userId, ipAddress };
}

export async function resetPassword(database, args) {
  return withTransaction(database, (client) => resetPasswordWithClient(client, args));
}

export async function verifyEmailWithClient(client, { token, ipAddress }) {
  const userId = await consumeAuthToken(client, { token, purpose: 'email_verification' });
  await client.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userId]);
  await client.query(
    `UPDATE auth_tokens SET used_at = now()
     WHERE user_id = $1 AND purpose = 'email_verification' AND used_at IS NULL`,
    [userId]
  );
  return { userId, ipAddress };
}

export async function verifyEmail(database, args) {
  return withTransaction(database, (client) => verifyEmailWithClient(client, args));
}
