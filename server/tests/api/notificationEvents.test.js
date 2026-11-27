import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedReferenceData } from '../../src/db/seed.js';
import { resetDatabase } from '../helpers/db.js';
import { createClient, csrfHeader, loginClient } from '../helpers/api.js';
import { createTestUser } from '../helpers/users.js';

let notifier;
let app;

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDatabase();
  await seedReferenceData(pool, { includeBootstrapUsers: false });
  notifier = { send: vi.fn().mockResolvedValue({ sent: true }) };
  app = createApp({ notifier });
});

async function portalClient(role = 'employee') {
  const user = await createTestUser({ role, firstName: 'Notify', lastName: role });
  const client = await loginClient(app, user.email, user.password);
  return { ...client, user };
}

async function createTicket(client) {
  const { rows: categories } = await pool.query("SELECT id FROM categories WHERE name = 'Hardware'");
  const { rows: subcategories } = await pool.query("SELECT id FROM subcategories WHERE name = 'Laptop / Desktop'");
  const response = await client.agent
    .post('/api/tickets')
    .set(csrfHeader(client))
    .send({
      title: 'Notification workflow ticket',
      description: 'This ticket verifies the lifecycle notification events.',
      categoryId: categories[0].id,
      subcategoryId: subcategories[0].id,
      priority: 'High'
    });
  expect(response.status).toBe(201);
  return response.body.data.ticket;
}

describe('ticket notification events', () => {
  it('emits lifecycle events after committed ticket actions', async () => {
    const requester = await portalClient();
    const agent = await portalClient('agent');
    const ticket = await createTicket(requester);

    await agent.agent
      .patch(`/api/tickets/${ticket.id}/assign`)
      .set(csrfHeader(agent))
      .send({ assigneeId: agent.user.id });

    await agent.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(agent))
      .send({ body: 'Internal-only diagnosis', isInternal: true });

    await agent.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(agent))
      .send({ body: 'Please try the replacement adapter.', isInternal: false });

    await agent.agent
      .patch(`/api/tickets/${ticket.id}/status`)
      .set(csrfHeader(agent))
      .send({ status: 'Resolved', resolutionNotes: 'Adapter replaced' });

    const events = notifier.send.mock.calls.map(([event]) => event);
    expect(events).toEqual([
      'ticket.created',
      'ticket.assigned',
      'ticket.agent_replied',
      'ticket.resolved'
    ]);

    const payloads = notifier.send.mock.calls.map(([, payload]) => JSON.stringify(payload));
    expect(payloads.some((payload) => payload.includes('Internal-only diagnosis'))).toBe(false);
    expect(notifier.send.mock.calls[0][1].recipients.map((recipient) => recipient.email))
      .toContain(requester.user.email);
    expect(notifier.send.mock.calls[1][1].recipients.map((recipient) => recipient.email))
      .toContain(agent.user.email);
  });

  it('notifies staff when the requester replies', async () => {
    const requester = await portalClient();
    const agent = await portalClient('agent');
    const ticket = await createTicket(requester);

    const response = await requester.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(requester))
      .send({ body: 'I can reproduce it after every reboot.' });
    expect(response.status).toBe(201);

    const events = notifier.send.mock.calls.map(([event]) => event);
    expect(events).toEqual(['ticket.created', 'ticket.employee_replied']);
    expect(notifier.send.mock.calls[1][1].recipients.map((recipient) => recipient.email))
      .toContain(agent.user.email);
  });

  it('notifies the acting agent when a status change auto-assigns the ticket', async () => {
    const requester = await portalClient();
    const agent = await portalClient('agent');
    const ticket = await createTicket(requester);

    const response = await agent.agent
      .patch(`/api/tickets/${ticket.id}/status`)
      .set(csrfHeader(agent))
      .send({ status: 'In Progress' });
    expect(response.status).toBe(200);
    expect(response.body.data.ticket.assigneeId).toBe(agent.user.id);

    const events = notifier.send.mock.calls.map(([event]) => event);
    expect(events).toEqual(['ticket.created', 'ticket.assigned', 'ticket.status_changed']);
    expect(notifier.send.mock.calls[1][1].recipients.map((recipient) => recipient.email))
      .toContain(agent.user.email);
  });

  it('emits a welcome event after successful employee registration', async () => {
    const client = await createClient(app);
    const response = await client.agent
      .post('/api/auth/register')
      .set(csrfHeader(client))
      .send({
        firstName: 'Nora',
        lastName: 'Newcomer',
        email: 'nora@example.com',
        password: 'StrongPass123!',
        confirmPassword: 'StrongPass123!'
      });
    expect(response.status).toBe(201);
    expect(notifier.send).toHaveBeenCalledTimes(2);
    expect(notifier.send.mock.calls[0][0]).toBe('user.registered');
    expect(notifier.send.mock.calls[0][1].recipients).toEqual([
      expect.objectContaining({ email: 'nora@example.com' })
    ]);
    expect(notifier.send.mock.calls[1][0]).toBe('auth.email_verification');
    expect(notifier.send.mock.calls[1][1].token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('still completes registration when notification delivery throws', async () => {
    notifier.send.mockRejectedValueOnce(new Error('mailer exploded'));
    const client = await createClient(app);
    const response = await client.agent
      .post('/api/auth/register')
      .set(csrfHeader(client))
      .send({
        firstName: 'Omar',
        lastName: 'Newcomer',
        email: 'omar@example.com',
        password: 'StrongPass123!',
        confirmPassword: 'StrongPass123!'
      });

    expect(response.status).toBe(201);
    expect(response.body.data.user).toMatchObject({
      email: 'omar@example.com',
      role: 'employee'
    });
  });

  it('does not emit an event when a write is rejected', async () => {
    const requester = await portalClient();
    const ticket = await createTicket(requester);
    notifier.send.mockClear();

    const rejected = await requester.agent
      .post(`/api/tickets/${ticket.id}/reopen`)
      .set(csrfHeader(requester));
    expect(rejected.status).toBe(422);
    expect(notifier.send).not.toHaveBeenCalled();
  });
});
