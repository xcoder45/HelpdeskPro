import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { pool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedReferenceData } from '../../src/db/seed.js';
import { resetDatabase } from '../helpers/db.js';
import { createClient, csrfHeader, loginClient } from '../helpers/api.js';
import { createTestUser } from '../helpers/users.js';

const app = createApp();

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDatabase();
  await seedReferenceData(pool, { includeBootstrapUsers: false });
});

function setCookies(response) {
  return response.headers['set-cookie'] ?? [];
}

describe('CSRF protection', () => {
  it('issues a readable CSRF token on safe requests', async () => {
    const response = await request(app).get('/api/auth/csrf');

    expect(response.status).toBe(200);
    expect(response.body.data.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    const csrfCookie = setCookies(response).find((cookie) => cookie.startsWith('csrf_token='));
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).toContain('SameSite=Strict');
    expect(csrfCookie).not.toContain('HttpOnly');
  });

  it('rejects state-changing requests without a matching token', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        firstName: 'No', lastName: 'Token', email: 'no-token@example.com',
        password: 'ValidPass123!', confirmPassword: 'ValidPass123!'
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a well-formed but incorrect CSRF token', async () => {
    const client = await createClient(app);
    const response = await client.agent
      .post('/api/auth/register')
      .set('x-csrf-token', 'f'.repeat(64))
      .send({
        firstName: 'Wrong', lastName: 'Token', email: 'wrong-token@example.com',
        password: 'ValidPass123!', confirmPassword: 'ValidPass123!'
      });

    expect(response.status).toBe(403);
    const { rowCount } = await pool.query('SELECT 1 FROM users WHERE email = $1', ['wrong-token@example.com']);
    expect(rowCount).toBe(0);
  });

  it('rotates the CSRF token on login and rejects the old token', async () => {
    const user = await createTestUser({ role: 'employee' });
    const client = await createClient(app);
    const previousToken = client.csrfToken;

    const login = await client.agent
      .post('/api/auth/login')
      .set(csrfHeader(client))
      .send({ email: user.email, password: user.password });
    expect(login.status).toBe(200);

    const rotatedToken = login.body.data.csrfToken;
    expect(rotatedToken).toMatch(/^[a-f0-9]{64}$/);
    expect(rotatedToken).not.toBe(previousToken);

    const stale = await client.agent
      .post('/api/auth/logout')
      .set('x-csrf-token', previousToken)
      .send({});
    expect(stale.status).toBe(403);

    const fresh = await client.agent
      .post('/api/auth/logout')
      .set('x-csrf-token', rotatedToken)
      .send({});
    expect(fresh.status).toBe(200);
  });
});

describe('registration', () => {
  it('validates input and creates an employee with a hashed password', async () => {
    const client = await createClient(app);
    const password = 'StrongPass123!';
    const response = await client.agent
      .post('/api/auth/register')
      .set(csrfHeader(client))
      .send({
        firstName: 'Nina', lastName: 'Newcomer', email: 'nina@example.com',
        password, confirmPassword: password, role: 'admin', isActive: false
      });

    expect(response.status).toBe(201);
    expect(response.body.data.user).toMatchObject({
      email: 'nina@example.com',
      role: 'employee',
      isActive: true
    });
    expect(JSON.stringify(response.body)).not.toContain(password);

    const { rows } = await pool.query(
      'SELECT password_hash, email_verified_at FROM users WHERE email = $1',
      ['nina@example.com']
    );
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$12\$/);
    expect(rows[0].email_verified_at).not.toBeNull();

    const accessCookie = setCookies(response).find((cookie) => cookie.startsWith('access_token='));
    expect(accessCookie).toBeDefined();
    expect(accessCookie).toContain('HttpOnly');
    expect(accessCookie).toContain('SameSite=Strict');
  });

  it('rejects weak and mismatched passwords', async () => {
    const client = await createClient(app);
    const weak = await client.agent
      .post('/api/auth/register')
      .set(csrfHeader(client))
      .send({
        firstName: 'Weak', lastName: 'Password', email: 'weak@example.com',
        password: 'simple', confirmPassword: 'simple'
      });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('BAD_REQUEST');

    const mismatch = await client.agent
      .post('/api/auth/register')
      .set(csrfHeader(client))
      .send({
        firstName: 'Miss', lastName: 'Match', email: 'mismatch@example.com',
        password: 'StrongPass123!', confirmPassword: 'Different123!'
      });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'confirmPassword' })
    ]));
  });

  it('rejects duplicate registration with a conflict', async () => {
    const client = await createClient(app);
    const payload = {
      firstName: 'Dup', lastName: 'User', email: 'duplicate@example.com',
      password: 'StrongPass123!', confirmPassword: 'StrongPass123!'
    };
    const first = await client.agent.post('/api/auth/register').set(csrfHeader(client)).send(payload);
    expect(first.status).toBe(201);
    client.csrfToken = first.body.data.csrfToken;

    const duplicate = await client.agent.post('/api/auth/register').set(csrfHeader(client)).send(payload);

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');
  });

  it('rolls back account creation when the audit write fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingDatabase = {
      query: (sql, params) => pool.query(sql, params),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (sql, params) => (
            typeof sql === 'string' && sql.includes('INSERT INTO audit_logs')
              ? Promise.reject(new Error('audit storage unavailable'))
              : client.query(sql, params)
          ),
          release: () => client.release()
        };
      }
    };
    const isolatedApp = createApp({ database: failingDatabase });
    const client = await createClient(isolatedApp);

    try {
      const response = await client.agent
        .post('/api/auth/register')
        .set(csrfHeader(client))
        .send({
          firstName: 'No', lastName: 'Audit', email: 'atomic@example.com',
          password: 'StrongPass123!', confirmPassword: 'StrongPass123!'
        });

      expect(response.status).toBe(500);
      const { rowCount } = await pool.query('SELECT 1 FROM users WHERE email = $1', ['atomic@example.com']);
      expect(rowCount).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rejects oversized JSON bodies with a 413 response', async () => {
    const client = await createClient(app);
    const response = await client.agent
      .post('/api/auth/login')
      .set(csrfHeader(client))
      .send({ email: 'oversized@example.com', password: 'x'.repeat(200_000) });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('login and session', () => {
  it('logs in with valid credentials and returns the current user', async () => {
    const user = await createTestUser({ role: 'employee', firstName: 'Logan' });
    const client = await loginClient(app, user.email, user.password);

    expect(client.user).toMatchObject({ id: user.id, role: 'employee', firstName: 'Logan' });

    const me = await client.agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.id).toBe(user.id);
  });

  it('returns the same generic error for unknown accounts and wrong passwords', async () => {
    const user = await createTestUser({ role: 'employee' });
    const client = await createClient(app);
    const unknown = await client.agent
      .post('/api/auth/login').set(csrfHeader(client))
      .send({ email: 'nobody@example.com', password: 'WrongPass123!' });
    const wrong = await client.agent
      .post('/api/auth/login').set(csrfHeader(client))
      .send({ email: user.email, password: 'WrongPass123!' });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('rejects inactive accounts and tampered tokens', async () => {
    const user = await createTestUser({ role: 'employee' });
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [user.id]);
    const client = await createClient(app);
    const inactive = await client.agent
      .post('/api/auth/login').set(csrfHeader(client))
      .send({ email: user.email, password: user.password });
    expect(inactive.status).toBe(401);

    const tampered = await request(app).get('/api/auth/me').set('Cookie', 'access_token=not.a.jwt');
    expect(tampered.status).toBe(401);
    expect(tampered.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an existing session when the account is deactivated', async () => {
    const user = await createTestUser({ role: 'employee' });
    const client = await loginClient(app, user.email, user.password);
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [user.id]);

    const me = await client.agent.get('/api/auth/me');
    expect(me.status).toBe(401);
    expect(me.body.error.message).toBe('Account is no longer active');
  });

  it('reports database failures as 500 rather than an invalid session', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenApp = createApp({
      database: {
        query: async () => {
          throw new Error('database offline');
        }
      }
    });
    const token = jwt.sign({ sub: '1', role: 'admin' }, env.JWT_SECRET, { expiresIn: '1h' });

    try {
      const response = await request(brokenApp)
        .get('/api/auth/me')
        .set('Cookie', `access_token=${token}`);

      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(response.body.error.message).not.toBe('Invalid or expired session');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('clears the access cookie on logout', async () => {
    const user = await createTestUser({ role: 'employee' });
    const client = await loginClient(app, user.email, user.password);
    const logout = await client.agent.post('/api/auth/logout').set(csrfHeader(client)).send({});

    expect(logout.status).toBe(200);
    const cleared = setCookies(logout).find((cookie) => cookie.startsWith('access_token='));
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970');
    const clearedCsrf = setCookies(logout).find((cookie) => cookie.startsWith('csrf_token='));
    expect(clearedCsrf).toContain('Expires=Thu, 01 Jan 1970');

    const me = await client.agent.get('/api/auth/me');
    expect(me.status).toBe(401);
  });

  it('revokes a previously issued token after logout', async () => {
    const user = await createTestUser({ role: 'employee' });
    const client = await loginClient(app, user.email, user.password);
    const issuedCookie = setCookies(client.response)
      .find((cookie) => cookie.startsWith('access_token='))
      .split(';')[0];

    expect((await client.agent.get('/api/auth/me')).status).toBe(200);

    const logout = await client.agent.post('/api/auth/logout').set(csrfHeader(client)).send({});
    expect(logout.status).toBe(200);

    const replay = await request(app).get('/api/auth/me').set('Cookie', issuedCookie);
    expect(replay.status).toBe(401);
    expect(replay.body.error.message).toBe('Session has been revoked');
  });

  it('rejects tokens signed with an unexpected algorithm', async () => {
    const wrongAlgorithm = jwt.sign(
      { sub: '1' }, env.JWT_SECRET, { algorithm: 'HS384', expiresIn: '1h' }
    );
    const unsigned = jwt.sign({ sub: '1' }, null, { algorithm: 'none' });

    for (const token of [wrongAlgorithm, unsigned]) {
      const response = await request(app).get('/api/auth/me').set('Cookie', `access_token=${token}`);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('audits logout with the acting user', async () => {
    const user = await createTestUser({ role: 'employee' });
    const client = await loginClient(app, user.email, user.password);
    const logout = await client.agent.post('/api/auth/logout').set(csrfHeader(client)).send({});
    expect(logout.status).toBe(200);

    const { rows } = await pool.query(
      "SELECT actor_id, action, entity_id FROM audit_logs WHERE action = 'auth.logout'"
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].actor_id)).toBe(user.id);
    expect(Number(rows[0].entity_id)).toBe(user.id);
  });

  it('writes audit events without passwords', async () => {
    const password = 'StrongPass123!';
    const client = await createClient(app);
    const registered = await client.agent.post('/api/auth/register').set(csrfHeader(client)).send({
      firstName: 'Audit', lastName: 'User', email: 'audit@example.com',
      password, confirmPassword: password
    });
    expect(registered.status).toBe(201);
    client.csrfToken = registered.body.data.csrfToken;

    await client.agent.post('/api/auth/login').set(csrfHeader(client)).send({
      email: 'audit@example.com', password: 'WrongPass123!'
    });
    await loginClient(app, 'audit@example.com', password);

    const { rows } = await pool.query('SELECT action, details FROM audit_logs ORDER BY id');
    const actions = rows.map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining([
      'auth.register', 'auth.login_failed', 'auth.login_success'
    ]));
    expect(JSON.stringify(rows)).not.toContain(password);
  });
});
