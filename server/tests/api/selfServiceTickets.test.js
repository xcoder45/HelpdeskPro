import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedReferenceData } from '../../src/db/seed.js';
import { resetDatabase } from '../helpers/db.js';
import { csrfHeader, loginClient } from '../helpers/api.js';
import { createTestUser } from '../helpers/users.js';

const app = createApp({ notifier: null });

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDatabase();
  await seedReferenceData(pool, { includeBootstrapUsers: false });
});

async function portalClient(role = 'employee') {
  const user = await createTestUser({ role, firstName: 'Self', lastName: role });
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
      title: 'Laptop will not boot after update',
      description: 'The laptop shows a black screen after the overnight update finished.',
      categoryId: categories[0].id,
      subcategoryId: subcategories[0].id,
      priority: 'High'
    });
  expect(response.status).toBe(201);
  return response.body.data.ticket;
}

async function detail(client, ticketId) {
  const response = await client.agent.get(`/api/tickets/${ticketId}`);
  expect(response.status).toBe(200);
  return response.body.data.ticket;
}

describe('employee self-service ticket API', () => {
  it('lets the requester edit an open ticket and records the change', async () => {
    const requester = await portalClient();
    const ticket = await createTicket(requester);

    const edited = await requester.agent
      .patch(`/api/tickets/${ticket.id}`)
      .set(csrfHeader(requester))
      .send({
        title: 'Laptop still will not boot',
        description: 'The laptop remains on a black screen after two more restarts.'
      });
    expect(edited.status).toBe(200);
    expect(edited.body.data.ticket).toMatchObject({
      title: 'Laptop still will not boot',
      description: 'The laptop remains on a black screen after two more restarts.'
    });

    const refreshed = await detail(requester, ticket.id);
    expect(refreshed.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'ticket_edited', fieldName: 'details' })
    ]));
  });

  it('rejects invalid edits and edits by other employees or staff', async () => {
    const requester = await portalClient();
    const other = await portalClient();
    const agent = await portalClient('agent');
    const ticket = await createTicket(requester);

    const invalid = await requester.agent
      .patch(`/api/tickets/${ticket.id}`)
      .set(csrfHeader(requester))
      .send({ title: 'ab', description: 'short' });
    expect(invalid.status).toBe(400);

    const otherEdit = await other.agent
      .patch(`/api/tickets/${ticket.id}`)
      .set(csrfHeader(other))
      .send({ title: 'Changed by another employee', description: 'This must not be allowed at all.' });
    expect(otherEdit.status).toBe(404);

    const staffEdit = await agent.agent
      .patch(`/api/tickets/${ticket.id}`)
      .set(csrfHeader(agent))
      .send({ title: 'Changed by staff', description: 'This must not be allowed at all.' });
    expect(staffEdit.status).toBe(403);
  });

  it('cancels an open ticket and lets the requester reopen it', async () => {
    const requester = await portalClient();
    const ticket = await createTicket(requester);

    const cancelled = await requester.agent
      .post(`/api/tickets/${ticket.id}/cancel`)
      .set(csrfHeader(requester));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.ticket).toMatchObject({
      status: 'Closed',
      resolutionNotes: 'Cancelled by requester'
    });
    expect(cancelled.body.data.ticket.resolvedAt).not.toBeNull();
    expect(cancelled.body.data.ticket.closedAt).not.toBeNull();

    const reopened = await requester.agent
      .post(`/api/tickets/${ticket.id}/reopen`)
      .set(csrfHeader(requester));
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.ticket).toMatchObject({
      status: 'New',
      resolutionNotes: null,
      resolvedAt: null,
      closedAt: null
    });

    const refreshed = await detail(requester, ticket.id);
    expect(refreshed.history.map((entry) => entry.action)).toEqual(expect.arrayContaining(['cancelled', 'reopened']));
  });

  it('reopens an assigned resolved ticket into an active status', async () => {
    const requester = await portalClient();
    const agent = await portalClient('agent');
    const ticket = await createTicket(requester);

    await agent.agent
      .patch(`/api/tickets/${ticket.id}/assign`)
      .set(csrfHeader(agent))
      .send({ assigneeId: agent.user.id });
    await agent.agent
      .patch(`/api/tickets/${ticket.id}/status`)
      .set(csrfHeader(agent))
      .send({ status: 'Resolved', resolutionNotes: 'Replaced the power adapter' });

    const closed = await requester.agent
      .post(`/api/tickets/${ticket.id}/close`)
      .set(csrfHeader(requester));
    expect(closed.status).toBe(200);

    const reopened = await requester.agent
      .post(`/api/tickets/${ticket.id}/reopen`)
      .set(csrfHeader(requester));
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.ticket).toMatchObject({
      status: 'In Progress',
      assigneeId: agent.user.id,
      resolutionNotes: null
    });

    const invalidReopen = await requester.agent
      .post(`/api/tickets/${ticket.id}/reopen`)
      .set(csrfHeader(requester));
    expect(invalidReopen.status).toBe(422);
  });

  it('blocks self-service actions that staff-only roles cannot bypass', async () => {
    const requester = await portalClient();
    const agent = await portalClient('agent');
    const ticket = await createTicket(requester);

    expect((await agent.agent.post(`/api/tickets/${ticket.id}/cancel`).set(csrfHeader(agent))).status).toBe(403);
    expect((await agent.agent.post(`/api/tickets/${ticket.id}/reopen`).set(csrfHeader(agent))).status).toBe(403);
  });
});
