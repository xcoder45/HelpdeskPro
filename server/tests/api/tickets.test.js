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

async function portalClient(role = 'employee') {
  const user = await createTestUser({ role, firstName: 'Portal', lastName: role });
  const client = await loginClient(app, user.email, user.password);
  return { ...client, user };
}

async function catalog() {
  const { rows: categories } = await pool.query("SELECT id FROM categories WHERE name = 'Hardware'");
  const { rows: otherCategories } = await pool.query("SELECT id FROM categories WHERE name = 'Software'");
  const { rows: subcategories } = await pool.query(
    "SELECT id FROM subcategories WHERE name = 'Laptop / Desktop'"
  );
  return {
    categoryId: categories[0].id,
    otherCategoryId: otherCategories[0].id,
    subcategoryId: subcategories[0].id
  };
}

function ticketPayload(overrides = {}, ids = null) {
  return {
    title: overrides.title ?? 'Laptop will not boot after update',
    description: overrides.description ?? 'The laptop shows a black screen after the overnight update finished.',
    categoryId: overrides.categoryId ?? ids?.categoryId,
    subcategoryId: overrides.subcategoryId ?? ids?.subcategoryId,
    priority: overrides.priority ?? 'High'
  };
}

async function createTicket(client, overrides = {}) {
  const ids = overrides.categoryId || overrides.otherCategoryId ? null : await catalog();
  const response = await client.agent
    .post('/api/tickets')
    .set(csrfHeader(client))
    .send(ticketPayload(overrides, ids));
  if (response.status !== 201) {
    throw new Error(`Ticket creation failed with ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body.data.ticket;
}

describe('employee ticket API', () => {
  it('creates a ticket with an SLA deadline derived from the selected priority', async () => {
    const client = await portalClient();
    const ids = await catalog();
    const ticket = await createTicket(client);

    expect(ticket).toMatchObject({
      title: 'Laptop will not boot after update',
      status: 'New',
      priority: 'High',
      categoryId: ids.categoryId,
      subcategoryId: ids.subcategoryId,
      requesterId: client.user.id,
      assigneeId: null
    });
    expect(ticket.ticketCode).toMatch(/^HD-\d{6,}$/);

    const due = new Date(ticket.responseDueAt).getTime();
    const created = new Date(ticket.createdAt).getTime();
    expect(due - created).toBe(4 * 60 * 60_000);

    const { rows: history } = await pool.query(
      "SELECT action, new_value FROM ticket_history WHERE ticket_id = $1",
      [ticket.id]
    );
    expect(history).toEqual([expect.objectContaining({ action: 'created', new_value: 'New' })]);

    const { rows: audit } = await pool.query(
      "SELECT action, entity_id FROM audit_logs WHERE action = 'ticket.created'"
    );
    expect(Number(audit[0].entity_id)).toBe(ticket.id);
  });

  it('rejects invalid input and references outside the selected category', async () => {
    const client = await portalClient();
    const ids = await catalog();

    const shortTitle = await client.agent.post('/api/tickets').set(csrfHeader(client)).send(
      ticketPayload({ title: 'No' }, ids)
    );
    expect(shortTitle.status).toBe(400);

    const badPriority = await client.agent.post('/api/tickets').set(csrfHeader(client)).send(
      ticketPayload({ priority: 'Urgent' }, ids)
    );
    expect(badPriority.status).toBe(400);

    const unknownCategory = await client.agent.post('/api/tickets').set(csrfHeader(client)).send(
      ticketPayload({ categoryId: 999_999 }, ids)
    );
    expect(unknownCategory.status).toBe(400);

    const mismatchedSubcategory = await client.agent.post('/api/tickets').set(csrfHeader(client)).send({
      ...ticketPayload({}, ids),
      categoryId: ids.otherCategoryId,
      subcategoryId: ids.subcategoryId
    });
    expect(mismatchedSubcategory.status).toBe(400);
    expect(mismatchedSubcategory.body.error.message).toMatch(/subcategory/i);

    await pool.query("UPDATE sla_rules SET is_active = false WHERE priority = 'Low'");
    const inactiveSla = await client.agent.post('/api/tickets').set(csrfHeader(client)).send(
      ticketPayload({ priority: 'Low' }, ids)
    );
    expect(inactiveSla.status).toBe(400);
    expect(inactiveSla.body.error.message).toMatch(/sla/i);

    const booleanCategory = await client.agent.post('/api/tickets').set(csrfHeader(client)).send({
      ...ticketPayload({}, ids),
      categoryId: true
    });
    expect(booleanCategory.status).toBe(400);

    const missingCsrf = await client.agent.post('/api/tickets').send(ticketPayload({}, ids));
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.body.error.message).toMatch(/csrf/i);
  });

  it('lists only the requester’s tickets with search, filters and pagination', async () => {
    const owner = await portalClient();
    const other = await portalClient();
    const ownTicket = await createTicket(owner, { title: 'Keyboard keys are sticking' });
    await createTicket(owner, { title: 'Second keyboard issue' });
    const otherTicket = await createTicket(other, { title: 'Another user keyboard issue' });

    const listed = await owner.agent.get('/api/tickets?limit=1&page=1');
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.meta).toMatchObject({ page: 1, limit: 1, total: 2, totalPages: 2 });
    expect(listed.body.data[0].id).not.toBe(otherTicket.id);

    const searched = await owner.agent.get('/api/tickets').query({ search: ownTicket.ticketCode });
    expect(searched.body.data).toHaveLength(1);
    expect(searched.body.data[0].id).toBe(ownTicket.id);

    const secondPage = await owner.agent.get('/api/tickets?limit=1&page=2');
    expect(secondPage.body.data).toHaveLength(1);
    expect(secondPage.body.meta).toMatchObject({ page: 2, total: 2, totalPages: 2 });
    expect(secondPage.body.data[0].id).not.toBe(listed.body.data[0].id);

    const priorityFiltered = await owner.agent.get('/api/tickets?priority=Low');
    expect(priorityFiltered.body.data).toEqual([]);
    expect(priorityFiltered.body.meta.totalPages).toBe(1);

    const booleanId = await owner.agent.get('/api/tickets/true');
    expect(booleanId.status).toBe(400);
  });

  it('treats LIKE wildcards literally in ticket search', async () => {
    const client = await portalClient();
    const literalTicket = await createTicket(client, { title: 'Printer shows 100% toner' });
    await createTicket(client, { title: 'Monitor is flickering' });

    const searched = await client.agent.get('/api/tickets').query({ search: '%' });
    expect(searched.status).toBe(200);
    expect(searched.body.data.map((ticket) => ticket.id)).toEqual([literalTicket.id]);
  });

  it('returns ticket detail with public comments only, plus history', async () => {
    const client = await portalClient();
    const ticket = await createTicket(client);

    const commented = await client.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(client))
      .send({ body: 'I tried restarting it twice.' });
    expect(commented.status).toBe(201);

    const agent = await createTestUser({ role: 'agent' });
    await pool.query(
      `INSERT INTO comments (ticket_id, author_id, body, is_internal)
       VALUES ($1, $2, 'Internal diagnosis details', true)`,
      [ticket.id, agent.id]
    );

    const detail = await client.agent.get(`/api/tickets/${ticket.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.ticket.comments).toHaveLength(1);
    expect(detail.body.data.ticket.comments[0]).toMatchObject({
      body: 'I tried restarting it twice.',
      isInternal: false,
      authorRole: 'employee'
    });
    expect(JSON.stringify(detail.body)).not.toContain('Internal diagnosis details');
    expect(detail.body.data.ticket.history.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['created', 'comment_added'])
    );
  });

  it('rejects internal comments and blocks comments on closed tickets', async () => {
    const client = await portalClient();
    const ticket = await createTicket(client);

    const internalAttempt = await client.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(client))
      .send({ body: 'Adding more detail.', isInternal: true });
    expect(internalAttempt.status).toBe(400);

    const comment = await client.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(client))
      .send({ body: 'Adding more detail.' });
    expect(comment.status).toBe(201);
    expect(comment.body.data.comment.isInternal).toBe(false);

    const { rows } = await pool.query('SELECT is_internal FROM comments WHERE id = $1', [comment.body.data.comment.id]);
    expect(rows[0].is_internal).toBe(false);

    await pool.query(
      `UPDATE tickets SET status = 'Closed', resolution_notes = 'Fixed', resolved_at = now() WHERE id = $1`,
      [ticket.id]
    );
    const rejected = await client.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(client))
      .send({ body: 'One more note.' });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('UNPROCESSABLE');
  });

  it('lets the requester close a resolved ticket but not an open one', async () => {
    const client = await portalClient();
    const ticket = await createTicket(client);

    const tooEarly = await client.agent.post(`/api/tickets/${ticket.id}/close`).set(csrfHeader(client)).send({});
    expect(tooEarly.status).toBe(422);

    await pool.query(
      `UPDATE tickets SET status = 'Resolved', resolution_notes = 'Replaced the device', resolved_at = now() WHERE id = $1`,
      [ticket.id]
    );
    const closed = await client.agent.post(`/api/tickets/${ticket.id}/close`).set(csrfHeader(client)).send({});
    expect(closed.status).toBe(200);
    expect(closed.body.data.ticket).toMatchObject({ status: 'Closed', resolutionNotes: 'Replaced the device' });
    expect(closed.body.data.ticket.closedAt).not.toBeNull();
    expect(closed.body.data.ticket.comments).toEqual([]);
    expect(closed.body.data.ticket.history.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['created', 'status_changed'])
    );

    const { rows: history } = await pool.query(
      "SELECT old_value, new_value FROM ticket_history WHERE action = 'status_changed' AND ticket_id = $1",
      [ticket.id]
    );
    expect(history).toEqual([expect.objectContaining({ old_value: 'Resolved', new_value: 'Closed' })]);
  });

  it('summarises the requester’s tickets including overdue items', async () => {
    const client = await portalClient();
    const openTicket = await createTicket(client);
    const resolvedTicket = await createTicket(client, { title: 'Second issue for summary' });

    await pool.query(
      "UPDATE tickets SET response_due_at = now() - interval '1 hour' WHERE id = $1",
      [openTicket.id]
    );
    await pool.query(
      `UPDATE tickets SET status = 'Resolved', resolution_notes = 'Completed', resolved_at = now() WHERE id = $1`,
      [resolvedTicket.id]
    );

    const summary = await client.agent.get('/api/tickets/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.data).toMatchObject({ total: 2, open: 1, resolved: 1, closed: 0, overdue: 1 });

    const listed = await client.agent.get('/api/tickets');
    expect(listed.body.data.find((ticket) => ticket.id === openTicket.id).isOverdue).toBe(true);
    expect(listed.body.data.find((ticket) => ticket.id === resolvedTicket.id).isOverdue).toBe(false);
  });

  it('does not expose another requester’s ticket', async () => {
    const owner = await portalClient();
    const other = await portalClient();
    const ticket = await createTicket(owner);

    const detail = await other.agent.get(`/api/tickets/${ticket.id}`);
    expect(detail.status).toBe(404);

    const comment = await other.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(other))
      .send({ body: 'Should not be allowed.' });
    expect(comment.status).toBe(404);

    const close = await other.agent.post(`/api/tickets/${ticket.id}/close`).set(csrfHeader(other)).send({});
    expect(close.status).toBe(404);
  });

  it('separates employee and staff ticket APIs', async () => {
    const employee = await portalClient();
    const agent = await portalClient('agent');
    const admin = await portalClient('admin');
    const ticket = await createTicket(employee);

    expect((await agent.agent.get('/api/tickets')).status).toBe(200);
    expect((await admin.agent.get('/api/tickets')).status).toBe(200);
    expect((await employee.agent.get('/api/tickets/assignees')).status).toBe(403);

    const assign = await employee.agent
      .patch(`/api/tickets/${ticket.id}/assign`)
      .set(csrfHeader(employee))
      .send({ assigneeId: agent.user.id });
    expect(assign.status).toBe(403);

    expect((await request(app).get('/api/tickets')).status).toBe(401);
    expect((await request(app).get('/api/categories')).status).toBe(401);
  });

  it('serves the active category catalog with subcategories', async () => {
    const client = await portalClient();
    const response = await client.agent.get('/api/categories');

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(6);
    const hardware = response.body.data.find((category) => category.name === 'Hardware');
    expect(hardware.subcategories.map((item) => item.name)).toContain('Laptop / Desktop');

    await pool.query("UPDATE subcategories SET is_active = false WHERE name = 'Laptop / Desktop'");
    const updated = await client.agent.get('/api/categories');
    const refreshed = updated.body.data.find((category) => category.name === 'Hardware');
    expect(refreshed.subcategories.map((item) => item.name)).not.toContain('Laptop / Desktop');
  });
});
