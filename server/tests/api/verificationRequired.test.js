import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    env: { ...actual.env, REQUIRE_EMAIL_VERIFICATION: true }
  };
});

const { createApp } = await import('../../src/app.js');
const { pool } = await import('../../src/db/pool.js');
const { runMigrations } = await import('../../src/db/migrate.js');
const { seedReferenceData } = await import('../../src/db/seed.js');
const { resetDatabase } = await import('../helpers/db.js');
const { createClient, csrfHeader } = await import('../helpers/api.js');

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

describe('REQUIRE_EMAIL_VERIFICATION', () => {
  it('withholds a session until the address is verified', async () => {
    const client = await createClient(app);
    const registered = await client.agent
      .post('/api/auth/register')
      .set(csrfHeader(client))
      .send({
        firstName: 'Vera', lastName: 'Verify', email: 'vera@example.com',
        password: 'StrongPass123!', confirmPassword: 'StrongPass123!'
      });
    expect(registered.status).toBe(201);
    expect(registered.body.data.requiresVerification).toBe(true);
    expect(registered.headers['set-cookie'].some((cookie) => cookie.startsWith('access_token=')))
      .toBe(false);
    client.csrfToken = registered.body.data.csrfToken;

    const blocked = await client.agent
      .post('/api/auth/login')
      .set(csrfHeader(client))
      .send({ email: 'vera@example.com', password: 'StrongPass123!' });
    expect(blocked.status).toBe(401);
    expect(blocked.body.error.message).toMatch(/verify your email/i);

    const token = notifier.send.mock.calls
      .find(([event]) => event === 'auth.email_verification')?.[1]?.token;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const confirmed = await client.agent
      .post('/api/auth/verification/confirm')
      .set(csrfHeader(client))
      .send({ token });
    expect(confirmed.status).toBe(200);

    const login = await client.agent
      .post('/api/auth/login')
      .set(csrfHeader(client))
      .send({ email: 'vera@example.com', password: 'StrongPass123!' });
    expect(login.status).toBe(200);

    const me = await client.agent.get('/api/auth/me');
    expect(me.status).toBe(200);
  });
});
