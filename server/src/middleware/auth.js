import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { unauthorized } from '../utils/errors.js';
import { formatUser } from '../modules/users/service.js';
import { hashToken } from '../modules/auth/lifecycle.js';

export function createRequireAuth(database = pool) {
  return async function requireAuth(req, _res, next) {
    const token = req.cookies?.access_token;
    if (!token) return next(unauthorized('Authentication required'));

    let payload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return next(unauthorized('Invalid or expired session'));
    }

    try {
      const { rows } = await database.query(
        `SELECT u.*, r.name AS role
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1 AND u.is_active = true`,
        [payload.sub]
      );
      if (rows.length === 0) return next(unauthorized('Account is no longer active'));

      const expectedVersion = Number(rows[0].token_version ?? 0);
      if (Number(payload.ver ?? 0) !== expectedVersion) {
        return next(unauthorized('Session has been revoked'));
      }

      if (typeof payload.jti !== 'string' || payload.jti.length < 16) {
        return next(unauthorized('Session has been revoked'));
      }
      const { rows: sessions } = await database.query(
        `SELECT id, token_hash, expires_at, revoked_at
         FROM user_sessions
         WHERE jti = $1 AND user_id = $2`,
        [payload.jti, payload.sub]
      );
      const session = sessions[0];
      if (!session
        || session.revoked_at
        || new Date(session.expires_at).getTime() <= Date.now()
        || session.token_hash !== hashToken(token)) {
        return next(unauthorized('Session has been revoked'));
      }

      try {
        await database.query(
          'UPDATE user_sessions SET last_used_at = now() WHERE id = $1',
          [session.id]
        );
      } catch (error) {
        console.warn('[auth] session last-used update failed:', error?.message ?? error);
      }

      req.user = formatUser(rows[0]);
      req.auth = { tokenPayload: payload, sessionId: Number(session.id) };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export const requireAuth = createRequireAuth();
