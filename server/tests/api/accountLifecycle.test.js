import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedReferenceData } from '../../src/db/seed.js';
import { resetDatabase } from '../helpers/db.js';
import { createClient, csrfHeader, loginClient } from '../helpers/api.js';
import { createTestUser } from '../helpers/users.js';

const notifier = { send: vi.fn().mockResolvedValue({ sent: true }) };
const app = createApp({ notifier });

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDatabase();
  notifier.send.mockClear();
  await seedReferenceData(pool, { includeBootstrapUsers: false });
});

function resetToken() {
  const call = notifier.send.mock.calls.find(([event]) => event === 'auth.password_reset');
  return call?.[1]?.token;
}

function verificationToken() {
  const call = notifier.send.mock.calls.find(([event]) => event === 'auth.email_verification');
  return call?.[1]?.token;
}

function latestVerificationToken() {
  const calls = notifier.send.mock.calls.filter(([event]) => event === 'auth.email_verification');
  return calls.at(-1)?.[1]?.token;
}

describe('tracked sessions', () => {
  it('lists active sessions and revokes only the selected one', async () => {
    const user = await createTestUser({ role: 'employee' });
    const first = await loginClient(app, user.email, user.password);
    const second = await loginClient(app, user.email, user.password);

    const listed = await first.agent.get('/api/auth/sessions');
    expect(listed.status).toBe(200);
    expect(listed.body.data.sessions).toHaveLength(2);
    expect(listed.body.data.sessions.filter((session) => session.current)).toHaveLength(1);

    const target = listed.body.data.sessions.find((session) => session.current);
    const response = await first.agent
      .delete(`/api/auth/sessions/${target.id}`)
      .set(csrfHeader(first));
    expect(response.status).toBe(200);

    const { rows: audits } = await pool.query(`
      SELECT action, details FROM audit_logs WHERE action = 'auth.session_revoked'
    `);
    expect(audits).toHaveLength(1);
    expect(audits[0].details.sessionId).toBe(target.id);

    expect((await first.agent.get('/api/auth/me')).status).toBe(401);
    expect((await second.agent.get('/api/auth/me')).status).toBe(200);
  });

  it('revokes all other sessions while keeping the current one', async () => {
    const user = await createTestUser({ role: 'employee' });
    const first = await loginClient(app, user.email, user.password);
    const second = await loginClient(app, user.email, user.password);

    const response = await first.agent.delete('/api/auth/sessions').set(csrfHeader(first));
    expect(response.status).toBe(200);
    expect(response.body.data.revoked).toBe(1);

    const { rows: audits } = await pool.query(`
      SELECT action, details FROM audit_logs WHERE action = 'auth.sessions_revoked'
    `);
    expect(audits).toHaveLength(1);
    expect(audits[0].details.revoked).toBe(1);

    expect((await first.agent.get('/api/auth/me')).status).toBe(200);
    expect((await second.agent.get('/api/auth/me')).status).toBe(401);
  });

  it('logout does not revoke a different session', async () => {
    const user = await createTestUser({ role: 'employee' });
    const first = await loginClient(app, user.email, user.password);
    const second = await loginClient(app, user.email, user.password);

    const logout = await first.agent.post('/api/auth/logout').set(csrfHeader(first)).send({});
    expect(logout.status).toBe(200);
    expect((await first.agent.get('/api/auth/me')).status).toBe(401);
    expect((await second.agent.get('/api/auth/me')).status).toBe(200);
  });
});

describe('password reset', () => {
  it('returns the same generic response for unknown and known emails', async () => {
    const user = await createTestUser({ role: 'employee' });
    const client = await createClient(app);
    const unknown = await client.agent
      .post('/api/auth/password-reset/request')
      .set(csrfHeader(client))
      .send({ email: 'missing@example.com' });
    const known = await client.agent
      .post('/api/auth/password-reset/request')
      .set(csrfHeader(client))
      .send({ email: user.email });

    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(resetToken()).toMatch(/^[a-f0-9]{64}$/);
  });

  it('resets the password once and invalidates existing sessions', async () => {
    const user = await createTestUser({ role: 'employee' });
    const client = await createClient(app);
    await client.agent
      .post('/api/auth/password-reset/request')
      .set(csrfHeader(client))
      .send({ email: user.email });
    const session = await loginClient(app, user.email, user.password);
    const token = resetToken();

    const response = await client.agent
      .post('/api/auth/password-reset/confirm')
      .set(csrfHeader(client))
      .send({ token, password: 'BrandNewPass123!', confirmPassword: 'BrandNewPass123!' });
    expect(response.status).toBe(200);
    expect((await session.agent.get('/api/auth/me')).status).toBe(401);
    expect((await loginClient(app, user.email, 'BrandNewPass123!')).user.id).toBe(user.id);

    const replay = await client.agent
      .post('/api/auth/password-reset/confirm')
      .set(csrfHeader(client))
      .send({ token, password: 'AnotherPass123!', confirmPassword: 'AnotherPass123!' });
    expect(replay.status).toBe(400);

    const { rows } = await pool.query(
      "SELECT action FROM audit_logs WHERE action LIKE 'auth.password_reset%' ORDER BY id"
    );
    expect(rows.map((row) => row.action)).toEqual([
      'auth.password_reset_requested',
      'auth.password_reset_completed'
    ]);
  });
});

describe('email verification', () => {
  it('verifies an address with a single-use token', async () => {
    const user = await createTestUser({ role: 'employee' });
    const client = await createClient(app);
    const response = await client.agent
      .post('/api/auth/verification/resend')
      .set(csrfHeader(client))
      .send({ email: user.email });
    expect(response.status).toBe(200);

    const token = verificationToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const confirmed = await client.agent
      .post('/api/auth/verification/confirm')
      .set(csrfHeader(client))
      .send({ token });
    expect(confirmed.status).toBe(200);

    const { rows } = await pool.query(
      'SELECT email_verified_at FROM users WHERE id = $1',
      [user.id]
    );
    expect(rows[0].email_verified_at).not.toBeNull();

    const replay = await client.agent
      .post('/api/auth/verification/confirm')
      .set(csrfHeader(client))
      .send({ token });
    expect(replay.status).toBe(400);

    const resend = await client.agent
      .post('/api/auth/verification/resend')
      .set(csrfHeader(client))
      .send({ email: user.email });
    expect(resend.status).toBe(200);
    expect(notifier.send.mock.calls.filter(([event]) => event === 'auth.email_verification')).toHaveLength(1);
  });

  it('invalidates an older verification link when a new one is requested', async () => {
    const user = await createTestUser({ role: 'employee' });
    const client = await createClient(app);
    const request = () => client.agent
      .post('/api/auth/verification/resend')
      .set(csrfHeader(client))
      .send({ email: user.email });

    expect((await request()).status).toBe(200);
    const firstToken = verificationToken();
    expect((await request()).status).toBe(200);
    const secondToken = latestVerificationToken();
    expect(secondToken).not.toBe(firstToken);

    const stale = await client.agent
      .post('/api/auth/verification/confirm')
      .set(csrfHeader(client))
      .send({ token: firstToken });
    expect(stale.status).toBe(400);

    const confirmed = await client.agent
      .post('/api/auth/verification/confirm')
      .set(csrfHeader(client))
      .send({ token: secondToken });
    expect(confirmed.status).toBe(200);
  });

  it('requires a fresh verification link after the email address changes', async () => {
    const user = await createTestUser({ role: 'employee' });
    const client = await createClient(app);
    await client.agent
      .post('/api/auth/verification/resend')
      .set(csrfHeader(client))
      .send({ email: user.email });
    const oldToken = verificationToken();

    const signedIn = await loginClient(app, user.email, user.password);
    const updated = await signedIn.agent
      .patch('/api/users/me')
      .set(csrfHeader(signedIn))
      .send({ email: 'changed-address@example.com' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.user.emailVerifiedAt).toBeNull();

    const stale = await client.agent
      .post('/api/auth/verification/confirm')
      .set(csrfHeader(client))
      .send({ token: oldToken });
    expect(stale.status).toBe(400);

    await client.agent
      .post('/api/auth/verification/resend')
      .set(csrfHeader(client))
      .send({ email: 'changed-address@example.com' });
    const newToken = latestVerificationToken();
    expect(newToken).not.toBe(oldToken);

    const confirmed = await client.agent
      .post('/api/auth/verification/confirm')
      .set(csrfHeader(client))
      .send({ token: newToken });
    expect(confirmed.status).toBe(200);
  });
});
