import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { createRequireAuth } from '../../src/middleware/auth.js';
import { hashToken } from '../../src/modules/auth/lifecycle.js';

describe('requireAuth session tracking', () => {
  it('refreshes last_used_at on an authenticated request', async () => {
    const token = jwt.sign(
      { sub: '7', ver: 0, jti: 'a'.repeat(32) },
      env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' }
    );
    const queries = [];
    const database = {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('FROM users')) {
          return {
            rows: [{
              id: 7,
              first_name: 'Test',
              last_name: 'User',
              email: 'user@example.com',
              is_active: true,
              is_demo: false,
              role: 'employee',
              token_version: 0
            }]
          };
        }
        if (sql.includes('FROM user_sessions')) {
          return {
            rows: [{
              id: 11,
              token_hash: hashToken(token),
              expires_at: new Date(Date.now() + 3_600_000),
              revoked_at: null
            }]
          };
        }
        return { rowCount: 1 };
      }
    };
    const req = { cookies: { access_token: token } };
    const next = vi.fn();

    await createRequireAuth(database)(req, {}, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.auth).toEqual(expect.objectContaining({ sessionId: 11 }));
    expect(queries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sql: 'UPDATE user_sessions SET last_used_at = now() WHERE id = $1',
        params: [11]
      })
    ]));
  });
});
