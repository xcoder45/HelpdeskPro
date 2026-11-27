import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createUserRateLimiter } from '../../src/middleware/rateLimit.js';
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
  const user = await createTestUser({ role, firstName: 'Staff', lastName: role });
  const client = await loginClient(app, user.email, user.password);
  return { ...client, user };
}

async function catalog() {
  const { rows: categories } = await pool.query("SELECT id FROM categories WHERE name = 'Hardware'");
  const { rows: subcategories } = await pool.query(
    "SELECT id FROM subcategories WHERE name = 'Laptop / Desktop'"
  );
  return {
    categoryId: categories[0].id,
    subcategoryId: subcategories[0].id
  };
}

async function createTicket(client, overrides = {}) {
  const ids = await catalog();
  const response = await client.agent
    .post('/api/tickets')
    .set(csrfHeader(client))
    .send({
      title: overrides.title ?? 'Laptop will not boot after update',
      description: overrides.description ?? 'The laptop shows a black screen after the overnight update finished.',
      categoryId: ids.categoryId,
      subcategoryId: ids.subcategoryId,
      priority: overrides.priority ?? 'High'
    });
  if (response.status !== 201) {
    throw new Error(`Ticket creation failed with ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body.data.ticket;
}

async function detail(client, id) {
  const response = await client.agent.get(`/api/tickets/${id}`);
  if (response.status !== 200) {
    throw new Error(`Ticket detail failed with ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body.data.ticket;
}

describe('staff ticket workspace API', () => {
  it('lists every ticket with staff filters and role-aware summaries', async () => {
    const requester = await portalClient();
    const otherRequester = await portalClient();
    const agent = await portalClient('agent');
    const first = await createTicket(requester, { title: 'Printer is jammed' });
    const second = await createTicket(otherRequester, { title: 'VPN keeps disconnecting', priority: 'Critical' });

    const listed = await agent.agent.get('/api/tickets?limit=1&page=1');
    expect(listed.status).toBe(200);
    expect(listed.body.meta).toMatchObject({ page: 1, total: 2, totalPages: 2 });
    expect(listed.body.data[0]).toMatchObject({ requesterName: 'Staff employee' });

    const priorityFiltered = await agent.agent.get('/api/tickets?priority=Critical');
    expect(priorityFiltered.body.data.map((ticket) => ticket.id)).toEqual([second.id]);

    const statusFiltered = await agent.agent.get('/api/tickets?status=New');
    expect(statusFiltered.body.data).toHaveLength(2);

    const unassigned = await agent.agent.get('/api/tickets?assigneeId=unassigned');
    expect(unassigned.body.data).toHaveLength(2);

    const searched = await agent.agent.get('/api/tickets').query({ search: first.ticketCode });
    expect(searched.body.data.map((ticket) => ticket.id)).toEqual([first.id]);

    const summary = await agent.agent.get('/api/tickets/summary');
    expect(summary.body.data).toMatchObject({ total: 2, open: 2, unassigned: 2, closed: 0 });

    const ownSummary = await requester.agent.get('/api/tickets/summary');
    expect(ownSummary.body.data).toMatchObject({ total: 1, open: 1, unassigned: 1 });
  });

  it('assigns and unassigns tickets with auditable history', async () => {
    const requester = await portalClient();
    const agent = await portalClient('agent');
    const admin = await portalClient('admin');
    const ticket = await createTicket(requester);

    const assignees = await agent.agent.get('/api/tickets/assignees');
    expect(assignees.status).toBe(200);
    expect(assignees.body.data.assignees.map((item) => item.id)).toEqual(
      expect.arrayContaining([agent.user.id, admin.user.id])
    );

    const invalidAssignee = await agent.agent
      .patch(`/api/tickets/${ticket.id}/assign`)
      .set(csrfHeader(agent))
      .send({ assigneeId: requester.user.id });
    expect(invalidAssignee.status).toBe(400);

    const assigned = await agent.agent
      .patch(`/api/tickets/${ticket.id}/assign`)
      .set(csrfHeader(agent))
      .send({ assigneeId: agent.user.id, note: 'Taking this one' });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data.ticket).toMatchObject({
      status: 'Assigned',
      assigneeId: agent.user.id,
      assigneeName: 'Staff agent'
    });

    const actions = assigned.body.data.ticket.history.map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(['assigned', 'status_changed']));
    expect(assigned.body.data.ticket.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'assigned',
        fieldName: 'assignee_id',
        oldValue: null,
        newValue: String(agent.user.id)
      })
    ]));

    const { rows: audit } = await pool.query(
      "SELECT details FROM audit_logs WHERE action = 'ticket.assigned' AND entity_id = $1",
      [ticket.id]
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ assigneeId: agent.user.id, toStatus: 'Assigned' });

    const unassigned = await agent.agent
      .patch(`/api/tickets/${ticket.id}/assign`)
      .set(csrfHeader(agent))
      .send({ assigneeId: null });
    expect(unassigned.status).toBe(200);
    expect(unassigned.body.data.ticket).toMatchObject({ status: 'New', assigneeId: null });
  });

  it('keeps internal notes private and records first response only for public replies', async () => {
    const requester = await portalClient();
    const agent = await portalClient('agent');
    const ticket = await createTicket(requester);

    const internal = await agent.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(agent))
      .send({ body: 'Internal diagnosis: suspected display cable.', isInternal: true });
    expect(internal.status).toBe(201);
    expect(internal.body.data.comment).toMatchObject({ isInternal: true, authorRole: 'agent' });

    const staffView = await detail(agent, ticket.id);
    expect(staffView.comments).toEqual([
      expect.objectContaining({ body: 'Internal diagnosis: suspected display cable.', isInternal: true })
    ]);
    expect(staffView.firstRespondedAt).toBeNull();
    expect(staffView.history.some((entry) => entry.action === 'internal_note_added')).toBe(true);

    const employeeView = await detail(requester, ticket.id);
    expect(employeeView.comments).toEqual([]);
    expect(employeeView.history.some((entry) => entry.action === 'internal_note_added')).toBe(false);
    expect(JSON.stringify(employeeView)).not.toContain('suspected display cable');

    const publicReply = await agent.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(agent))
      .send({ body: 'Please try a different display cable.', isInternal: false });
    expect(publicReply.status).toBe(201);

    const afterReply = await detail(agent, ticket.id);
    expect(afterReply.firstRespondedAt).not.toBeNull();
    expect(afterReply.comments).toHaveLength(2);

    await agent.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(agent))
      .send({ body: 'One more public update.', isInternal: false });
    const afterSecondReply = await detail(agent, ticket.id);
    expect(afterSecondReply.firstRespondedAt).toBe(afterReply.firstRespondedAt);

    const employeeAfterReply = await detail(requester, ticket.id);
    expect(employeeAfterReply.comments.map((comment) => comment.body)).toEqual([
      'Please try a different display cable.',
      'One more public update.'
    ]);
  });

  it('moves tickets through resolution, reopening and closure with guarded transitions', async () => {
    const requester = await portalClient();
    const agent = await portalClient('agent');
    const ticket = await createTicket(requester);

    const prematureClose = await agent.agent
      .patch(`/api/tickets/${ticket.id}/status`)
      .set(csrfHeader(agent))
      .send({ status: 'Closed' });
    expect(prematureClose.status).toBe(422);

    const assigned = await agent.agent
      .patch(`/api/tickets/${ticket.id}/assign`)
      .set(csrfHeader(agent))
      .send({ assigneeId: agent.user.id });
    expect(assigned.status).toBe(200);

    const inProgress = await agent.agent
      .patch(`/api/tickets/${ticket.id}/status`)
      .set(csrfHeader(agent))
      .send({ status: 'In Progress' });
    expect(inProgress.body.data.ticket.status).toBe('In Progress');

    const misplacedNotes = await agent.agent
      .patch(`/api/tickets/${ticket.id}/status`)
      .set(csrfHeader(agent))
      .send({ status: 'Pending', resolutionNotes: 'Not actually resolved' });
    expect(misplacedNotes.status).toBe(400);

    const missingNotes = await agent.agent
      .patch(`/api/tickets/${ticket.id}/status`)
      .set(csrfHeader(agent))
      .send({ status: 'Resolved' });
    expect(missingNotes.status).toBe(400);

    const resolved = await agent.agent
      .patch(`/api/tickets/${ticket.id}/status`)
      .set(csrfHeader(agent))
      .send({ status: 'Resolved', resolutionNotes: 'Replaced the display cable' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.ticket).toMatchObject({
      status: 'Resolved',
      resolutionNotes: 'Replaced the display cable'
    });
    expect(resolved.body.data.ticket.resolvedAt).not.toBeNull();

    const reopened = await agent.agent
      .patch(`/api/tickets/${ticket.id}/status`)
      .set(csrfHeader(agent))
      .send({ status: 'In Progress' });
    expect(reopened.body.data.ticket).toMatchObject({
      status: 'In Progress',
      resolvedAt: null,
      resolutionNotes: null
    });

    await agent.agent
      .patch(`/api/tickets/${ticket.id}/status`)
      .set(csrfHeader(agent))
      .send({ status: 'Resolved', resolutionNotes: 'Replaced the display cable again' });

    const closed = await requester.agent
      .post(`/api/tickets/${ticket.id}/close`)
      .set(csrfHeader(requester))
      .send({});
    expect(closed.status).toBe(200);
    expect(closed.body.data.ticket.status).toBe('Closed');

    const closedComment = await agent.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(agent))
      .send({ body: 'Follow-up after closure.' });
    expect(closedComment.status).toBe(422);

    const closedStatus = await agent.agent
      .patch(`/api/tickets/${ticket.id}/status`)
      .set(csrfHeader(agent))
      .send({ status: 'In Progress' });
    expect(closedStatus.status).toBe(422);
  });

  it('recalculates the response deadline when reprioritising an unanswered ticket', async () => {
    const requester = await portalClient();
    const agent = await portalClient('agent');
    const ticket = await createTicket(requester, { priority: 'Low' });

    expect(new Date(ticket.responseDueAt).getTime() - new Date(ticket.createdAt).getTime()).toBe(
      1440 * 60_000
    );

    const reprioritised = await agent.agent
      .patch(`/api/tickets/${ticket.id}/priority`)
      .set(csrfHeader(agent))
      .send({ priority: 'Critical' });
    expect(reprioritised.status).toBe(200);
    expect(new Date(reprioritised.body.data.ticket.responseDueAt).getTime()
      - new Date(ticket.createdAt).getTime()).toBe(60 * 60_000);
    expect(reprioritised.body.data.ticket.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'priority_changed', oldValue: 'Low', newValue: 'Critical' })
      ])
    );

    await agent.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(agent))
      .send({ body: 'We are investigating now.', isInternal: false });

    const dueAfterResponse = new Date(reprioritised.body.data.ticket.responseDueAt).getTime();
    const changedAfterResponse = await agent.agent
      .patch(`/api/tickets/${ticket.id}/priority`)
      .set(csrfHeader(agent))
      .send({ priority: 'High' });
    expect(new Date(changedAfterResponse.body.data.ticket.responseDueAt).getTime()).toBe(dueAfterResponse);
  });

  it('enforces staff-only permissions and strict input validation', async () => {
    const employee = await portalClient();
    const agent = await portalClient('agent');
    const ticket = await createTicket(employee);

    expect((await employee.agent.get('/api/tickets/assignees')).status).toBe(403);
    expect((await employee.agent.patch(`/api/tickets/${ticket.id}/status`)
      .set(csrfHeader(employee)).send({ status: 'In Progress' })).status).toBe(403);
    expect((await employee.agent.patch(`/api/tickets/${ticket.id}/priority`)
      .set(csrfHeader(employee)).send({ priority: 'High' })).status).toBe(403);

    const createAsAgent = await agent.agent
      .post('/api/tickets')
      .set(csrfHeader(agent))
      .send({
        title: 'Agent should not create employee tickets',
        description: 'This request should be rejected by role checks.',
        categoryId: 1,
        priority: 'Low'
      });
    expect(createAsAgent.status).toBe(403);

    const booleanId = await agent.agent.get('/api/tickets/true');
    expect(booleanId.status).toBe(400);

    const booleanAssignee = await agent.agent
      .patch(`/api/tickets/${ticket.id}/assign`)
      .set(csrfHeader(agent))
      .send({ assigneeId: true });
    expect(booleanAssignee.status).toBe(400);

    const missingCsrf = await agent.agent
      .patch(`/api/tickets/${ticket.id}/priority`)
      .send({ priority: 'High' });
    expect(missingCsrf.status).toBe(403);
  });

  it('supports every queue filter and keeps unassigned counts aligned with the list', async () => {
    const requester = await portalClient();
    const otherRequester = await portalClient();
    const agent = await portalClient('agent');
    const first = await createTicket(requester, { title: 'Printer is jammed', priority: 'Low' });
    const second = await createTicket(otherRequester, { title: 'VPN keeps disconnecting', priority: 'Critical' });
    const ids = await catalog();

    await agent.agent
      .patch(`/api/tickets/${first.id}/assign`)
      .set(csrfHeader(agent))
      .send({ assigneeId: agent.user.id });

    const byAssignee = await agent.agent.get(`/api/tickets?assigneeId=${agent.user.id}`);
    expect(byAssignee.body.data.map((ticket) => ticket.id)).toEqual([first.id]);

    const byRequester = await agent.agent.get(`/api/tickets?requesterId=${otherRequester.user.id}`);
    expect(byRequester.body.data.map((ticket) => ticket.id)).toEqual([second.id]);

    const byCategory = await agent.agent.get(`/api/tickets?categoryId=${ids.categoryId}`);
    expect(byCategory.body.data).toHaveLength(2);

    const sortedAsc = await agent.agent.get('/api/tickets?sort=title&order=asc');
    expect(sortedAsc.body.data.map((ticket) => ticket.ticketCode)).toEqual([first.ticketCode, second.ticketCode]);

    const sortedDesc = await agent.agent.get('/api/tickets?sort=title&order=desc');
    expect(sortedDesc.body.data.map((ticket) => ticket.ticketCode)).toEqual([second.ticketCode, first.ticketCode]);

    const combined = await agent.agent.get('/api/tickets?status=New&priority=Critical');
    expect(combined.body.data.map((ticket) => ticket.id)).toEqual([second.id]);

    await agent.agent
      .patch(`/api/tickets/${second.id}/assign`)
      .set(csrfHeader(agent))
      .send({ assigneeId: agent.user.id });
    await agent.agent
      .patch(`/api/tickets/${second.id}/status`)
      .set(csrfHeader(agent))
      .send({ status: 'Resolved', resolutionNotes: 'VPN profile rebuilt' });
    await agent.agent
      .patch(`/api/tickets/${second.id}/assign`)
      .set(csrfHeader(agent))
      .send({ assigneeId: null });

    const summary = await agent.agent.get('/api/tickets/summary');
    expect(summary.body.data.unassigned).toBe(0);
    const unassigned = await agent.agent.get('/api/tickets?assigneeId=unassigned');
    expect(unassigned.body.data).toEqual([]);
  });

  it('auto-assigns the acting staff member when reopening an unassigned resolved ticket', async () => {
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
      .send({ status: 'Resolved', resolutionNotes: 'Fixed by replacing the device' });
    await agent.agent
      .patch(`/api/tickets/${ticket.id}/assign`)
      .set(csrfHeader(agent))
      .send({ assigneeId: null });

    const reopened = await agent.agent
      .patch(`/api/tickets/${ticket.id}/status`)
      .set(csrfHeader(agent))
      .send({ status: 'In Progress' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.ticket).toMatchObject({
      status: 'In Progress',
      assigneeId: agent.user.id,
      resolvedAt: null,
      resolutionNotes: null
    });
    expect(reopened.body.data.ticket.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'assigned', newValue: String(agent.user.id) })
    ]));
  });

  it('rate-limits ticket writes per staff user when the limiter is enabled', async () => {
    const limitedApp = createApp({
      writeRateLimiter: createUserRateLimiter({ limit: 2, skip: () => false })
    });
    const requester = await portalClient();
    const agentUser = await createTestUser({ role: 'agent', firstName: 'Rate', lastName: 'Agent' });
    const agent = await loginClient(limitedApp, agentUser.email, agentUser.password);
    const ticket = await createTicket(requester);

    const first = await agent.agent
      .patch(`/api/tickets/${ticket.id}/priority`)
      .set(csrfHeader(agent))
      .send({ priority: 'Medium' });
    const second = await agent.agent
      .patch(`/api/tickets/${ticket.id}/priority`)
      .set(csrfHeader(agent))
      .send({ priority: 'High' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const blocked = await agent.agent
      .patch(`/api/tickets/${ticket.id}/priority`)
      .set(csrfHeader(agent))
      .send({ priority: 'Critical' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');

    const unchanged = await detail(agent, ticket.id);
    expect(unchanged.priority).toBe('High');
  });
});
