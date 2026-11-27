import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedReferenceData } from '../../src/db/seed.js';
import { resetDatabase } from '../helpers/db.js';
import { csrfHeader, loginClient } from '../helpers/api.js';
import { createTestUser } from '../helpers/users.js';

const app = createApp();

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDatabase();
  await seedReferenceData(pool, { includeBootstrapUsers: false });
});

async function adminClient() {
  const admin = await createTestUser({ role: 'admin', firstName: 'Alice', lastName: 'Admin' });
  const client = await loginClient(app, admin.email, admin.password);
  return { ...client, admin };
}

describe('role-based access control', () => {
  it('denies employees access to user administration', async () => {
    const employee = await createTestUser({ role: 'employee' });
    const client = await loginClient(app, employee.email, employee.password);

    const list = await client.agent.get('/api/users');
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('FORBIDDEN');

    const create = await client.agent
      .post('/api/users').set(csrfHeader(client))
      .send({
        firstName: 'Bad', lastName: 'Actor', email: 'bad@example.com',
        password: 'StrongPass123!', role: 'admin'
      });
    expect(create.status).toBe(403);
  });

  it('requires authentication for user endpoints', async () => {
    const response = await request(app).get('/api/users');
    expect(response.status).toBe(401);
  });
});

describe('user administration', () => {
  it('lists users with pagination, search and role filters for admins', async () => {
    const { agent } = await adminClient();
    await createTestUser({ role: 'agent', firstName: 'Searchable', lastName: 'Agent' });
    await createTestUser({ role: 'employee', firstName: 'Other', lastName: 'Person' });

    const response = await agent.get('/api/users?role=agent&search=Searchable&page=1&limit=5');
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({ role: 'agent', firstName: 'Searchable' });
    expect(response.body.meta).toMatchObject({ page: 1, limit: 5, total: 1, totalPages: 1 });
  });

  it('creates agents and rejects duplicate emails', async () => {
    const { agent, admin } = await adminClient();
    const email = 'new-agent@example.com';
    const created = await agent.post('/api/users').set('x-csrf-token', (await agent.get('/api/auth/csrf')).body.data.csrfToken).send({
      firstName: 'New', lastName: 'Agent', email,
      password: 'StrongPass123!', role: 'agent'
    });

    expect(created.status).toBe(201);
    expect(created.body.data.user).toMatchObject({ email, role: 'agent' });
    expect(created.body.data.user.password_hash).toBeUndefined();

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE email = $1', [email]);
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$12\$/);

    const duplicate = await agent.post('/api/users').set('x-csrf-token', (await agent.get('/api/auth/csrf')).body.data.csrfToken).send({
      firstName: 'Dup', lastName: 'Agent', email,
      password: 'StrongPass123!', role: 'agent'
    });
    expect(duplicate.status).toBe(409);

    const { rows: auditRows } = await pool.query(
      "SELECT action, entity_id FROM audit_logs WHERE action = 'user.created'"
    );
    expect(auditRows).toHaveLength(1);
    expect(Number(auditRows[0].entity_id)).toBe(created.body.data.user.id);
    expect(admin.id).toBeGreaterThan(0);
  });

  it('reads and updates users, and records audit entries', async () => {
    const { agent, admin } = await adminClient();
    const target = await createTestUser({ role: 'employee', firstName: 'Before' });
    const csrfToken = (await agent.get('/api/auth/csrf')).body.data.csrfToken;

    const read = await agent.get(`/api/users/${target.id}`);
    expect(read.status).toBe(200);
    expect(read.body.data.user.id).toBe(target.id);

    const updated = await agent.patch(`/api/users/${target.id}`)
      .set('x-csrf-token', csrfToken)
      .send({ role: 'agent', isActive: false, firstName: 'After' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.user).toMatchObject({ role: 'agent', isActive: false, firstName: 'After' });

    const missing = await agent.get('/api/users/999999');
    expect(missing.status).toBe(404);

    const { rows } = await pool.query(
      "SELECT action FROM audit_logs WHERE action LIKE 'user.%' ORDER BY id"
    );
    expect(rows.map((row) => row.action)).toContain('user.updated');
    expect(admin.id).toBeGreaterThan(0);
  });

  it('prevents an administrator from changing or deactivating their own account', async () => {
    const { agent, admin } = await adminClient();
    const csrfToken = (await agent.get('/api/auth/csrf')).body.data.csrfToken;

    const selfChange = await agent.patch(`/api/users/${admin.id}`)
      .set('x-csrf-token', csrfToken)
      .send({ role: 'employee' });
    expect(selfChange.status).toBe(422);
    expect(selfChange.body.error.code).toBe('UNPROCESSABLE');

    const deactivate = await agent.patch(`/api/users/${admin.id}`)
      .set('x-csrf-token', csrfToken)
      .send({ isActive: false });
    expect(deactivate.status).toBe(422);
  });

  it('lets users update their own profile without changing role', async () => {
    const { agent, admin } = await adminClient();
    const csrfToken = (await agent.get('/api/auth/csrf')).body.data.csrfToken;

    const updated = await agent.patch('/api/users/me')
      .set('x-csrf-token', csrfToken)
      .send({ firstName: 'Updated', role: 'employee' });

    expect(updated.status).toBe(200);
    expect(updated.body.data.user).toMatchObject({ firstName: 'Updated', role: 'admin' });

    const me = await agent.get('/api/auth/me');
    expect(me.body.data.user.id).toBe(admin.id);
  });

  it('enforces role changes on already-issued sessions', async () => {
    const { agent } = await adminClient();
    const target = await createTestUser({ role: 'admin', firstName: 'Demote' });
    const targetClient = await loginClient(app, target.email, target.password);
    const csrfToken = (await agent.get('/api/auth/csrf')).body.data.csrfToken;

    const updated = await agent.patch(`/api/users/${target.id}`)
      .set('x-csrf-token', csrfToken)
      .send({ role: 'employee' });
    expect(updated.status).toBe(200);

    const denied = await targetClient.agent.get('/api/users');
    expect(denied.status).toBe(403);
  });

  it('treats search input as literal text rather than SQL', async () => {
    const { agent } = await adminClient();
    const response = await agent.get('/api/users').query({ search: "%' OR 1=1 --" });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });
});
