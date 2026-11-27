import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedReferenceData } from '../../src/db/seed.js';
import { resetDatabase, createTicket as insertTicket } from '../helpers/db.js';
import { createClient, csrfHeader, loginClient } from '../helpers/api.js';
import { createTestUser } from '../helpers/users.js';

const app = createApp({ notifier: null });
const DAY = 24 * 60 * 60_000;

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDatabase();
  await seedReferenceData(pool, { includeBootstrapUsers: false });
});

async function portalClient(role) {
  const user = await createTestUser({ role, firstName: 'Dashboard', lastName: role });
  const client = await loginClient(app, user.email, user.password);
  return { ...client, user };
}

async function makeTicket({
  priority = 'High',
  status = 'New',
  requesterId,
  assigneeId = null,
  categoryName = 'Hardware',
  createdAt,
  responseDueAt,
  firstRespondedAt = null,
  resolvedAt = null,
  closedAt = null,
  cancelledAt = null
}) {
  const { rows: categories } = await pool.query('SELECT id FROM categories WHERE name = $1', [categoryName]);
  const dueAt = responseDueAt ?? new Date(Date.now() + DAY);
  const ticket = await insertTicket({
    priority,
    status,
    requesterId,
    responseDueAt: dueAt,
    resolvedAt,
    resolutionNotes: ['Resolved', 'Closed'].includes(status) ? 'Completed during dashboard testing' : null,
    title: `Dashboard test ticket ${priority}`,
    description: 'A ticket used to verify dashboard aggregates.'
  });
  await pool.query(
    `UPDATE tickets
     SET assignee_id = $2, category_id = $3, created_at = $4, response_due_at = $5,
         first_responded_at = $6, resolved_at = $7, closed_at = $8, cancelled_at = $9
     WHERE id = $1`,
    [
      ticket.id, assigneeId, categories[0].id, createdAt, dueAt,
      firstRespondedAt, resolvedAt, closedAt, cancelledAt
    ]
  );
  if (['Resolved', 'Closed'].includes(status) && resolvedAt) {
    await pool.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value, created_at)
       VALUES ($1, $2, 'status_changed', 'status', 'New', 'Resolved', $3)`,
      [ticket.id, requesterId, resolvedAt]
    );
  }
  return ticket;
}

describe('dashboard analytics API', () => {
  it('restricts dashboard data to administrators', async () => {
    const admin = await portalClient('admin');
    const agent = await portalClient('agent');
    const employee = await portalClient('employee');

    expect((await admin.agent.get('/api/dashboard/overview')).status).toBe(200);
    for (const client of [agent, employee]) {
      for (const path of [
        '/overview', '/summary', '/priority', '/category',
        '/weekly-trends', '/agent-workload', '/average-resolution-time'
      ]) {
        expect((await client.agent.get(`/api/dashboard${path}`)).status).toBe(403);
      }
    }
  });

  it('derives every summary figure from database records', async () => {
    const admin = await portalClient('admin');
    const employee = await portalClient('employee');
    const agent = await portalClient('agent');
    const now = Date.now();

    await makeTicket({
      status: 'New', priority: 'High', requesterId: employee.user.id,
      assigneeId: agent.user.id, createdAt: new Date(now - 10 * DAY),
      responseDueAt: new Date(now - 9 * DAY)
    });
    await makeTicket({
      status: 'Resolved', priority: 'Critical', requesterId: employee.user.id,
      assigneeId: agent.user.id, createdAt: new Date(now - 8 * DAY),
      resolvedAt: new Date(now - DAY), firstRespondedAt: new Date(now - 7 * DAY),
      responseDueAt: new Date(now - 7 * DAY)
    });
    await makeTicket({
      status: 'Closed', priority: 'Low', requesterId: employee.user.id,
      assigneeId: agent.user.id, createdAt: new Date(now - 5 * DAY),
      resolvedAt: new Date(now - 4 * DAY), closedAt: new Date(now - 4 * DAY),
      responseDueAt: new Date(now - 4 * DAY)
    });
    await makeTicket({
      status: 'In Progress', priority: 'Medium', requesterId: employee.user.id,
      createdAt: new Date(now - 2 * DAY), responseDueAt: new Date(now + DAY)
    });

    const response = await admin.agent.get('/api/dashboard/overview?weeks=2');
    expect(response.status).toBe(200);
    expect(response.body.data.summary).toMatchObject({
      total: 4,
      open: 2,
      unassigned: 1,
      resolved: 1,
      closed: 1,
      overdue: 1
    });
  });

  it('breaks tickets down by priority and category including empty buckets', async () => {
    const admin = await portalClient('admin');
    const employee = await portalClient('employee');
    const now = Date.now();

    await makeTicket({ priority: 'High', requesterId: employee.user.id, createdAt: new Date(now - DAY) });
    await makeTicket({
      priority: 'Critical', requesterId: employee.user.id,
      categoryName: 'Software', createdAt: new Date(now - DAY)
    });
    await makeTicket({
      priority: 'Medium', requesterId: employee.user.id,
      categoryName: 'Software', createdAt: new Date(now - DAY)
    });

    const overview = await admin.agent.get('/api/dashboard/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.data.priority).toEqual([
      { priority: 'Critical', total: 1 },
      { priority: 'High', total: 1 },
      { priority: 'Medium', total: 1 },
      { priority: 'Low', total: 0 }
    ]);

    const category = overview.body.data.category;
    expect(category[0]).toMatchObject({ category: 'Software', total: 2 });
    expect(category.find((row) => row.category === 'Hardware')).toMatchObject({ total: 1 });
    expect(category.find((row) => row.category === 'Other')).toMatchObject({ total: 0 });
  });

  it('reports weekly trends and average resolution time from ticket timestamps', async () => {
    const admin = await portalClient('admin');
    const employee = await portalClient('employee');
    const { rows } = await pool.query("SELECT date_trunc('week', now()) AS week_start");
    const weekStart = rows[0].week_start.getTime();

    await makeTicket({
      requesterId: employee.user.id,
      createdAt: new Date(weekStart + DAY),
      responseDueAt: new Date(weekStart + 2 * DAY)
    });
    await makeTicket({
      requesterId: employee.user.id,
      createdAt: new Date(weekStart - 3 * DAY),
      responseDueAt: new Date(weekStart - 2 * DAY)
    });
    await makeTicket({
      status: 'Resolved', requesterId: employee.user.id,
      createdAt: new Date(weekStart - 8 * DAY),
      resolvedAt: new Date(weekStart + DAY),
      firstRespondedAt: new Date(weekStart - 7 * DAY),
      responseDueAt: new Date(weekStart - 7 * DAY)
    });

    const response = await admin.agent.get('/api/dashboard/overview?weeks=2');
    expect(response.status).toBe(200);
    expect(response.body.data.weeklyTrends).toHaveLength(2);
    expect(response.body.data.weeklyTrends.map((row) => row.created)).toEqual([1, 1]);
    expect(response.body.data.weeklyTrends.map((row) => row.resolved)).toEqual([0, 1]);
    expect(response.body.data.averageResolutionTime).toEqual({
      resolvedTickets: 1,
      averageResolutionMinutes: 12960
    });
  });

  it('reports agent workload including agents with no tickets', async () => {
    const admin = await portalClient('admin');
    const employee = await portalClient('employee');
    const busyAgent = await portalClient('agent');
    const idleAgent = await createTestUser({
      role: 'agent', firstName: 'Idle', lastName: 'Agent', email: 'idle.agent@helpdesk.local'
    });
    const now = Date.now();

    await makeTicket({
      requesterId: employee.user.id, assigneeId: busyAgent.user.id,
      createdAt: new Date(now - DAY), responseDueAt: new Date(now + DAY)
    });
    await makeTicket({
      status: 'Resolved', requesterId: employee.user.id, assigneeId: busyAgent.user.id,
      createdAt: new Date(now - 2 * DAY), resolvedAt: new Date(now - DAY),
      responseDueAt: new Date(now - DAY)
    });

    const response = await admin.agent.get('/api/dashboard/agent-workload');
    expect(response.status).toBe(200);
    const workload = response.body.data;
    expect(workload.find((row) => row.id === busyAgent.user.id)).toMatchObject({
      open: 1, assigned: 2, completed: 1
    });
    expect(workload.find((row) => row.id === idleAgent.id)).toMatchObject({
      open: 0, assigned: 0, completed: 0
    });
  });

  it('returns zeroed aggregates when no tickets exist', async () => {
    const admin = await portalClient('admin');

    const response = await admin.agent.get('/api/dashboard/overview?weeks=4');
    expect(response.status).toBe(200);
    expect(response.body.data.summary).toMatchObject({
      total: 0,
      open: 0,
      unassigned: 0,
      resolved: 0,
      closed: 0,
      overdue: 0
    });
    expect(response.body.data.priority.every((row) => row.total === 0)).toBe(true);
    expect(response.body.data.category.every((row) => row.total === 0)).toBe(true);
    expect(response.body.data.weeklyTrends).toHaveLength(4);
    expect(response.body.data.weeklyTrends.every((row) => (
      row.created === 0 && row.resolved === 0
    ))).toBe(true);
    expect(response.body.data.averageResolutionTime).toEqual({
      resolvedTickets: 0,
      averageResolutionMinutes: 0
    });
  });

  it('keeps deactivated categories that still have tickets in category totals', async () => {
    const admin = await portalClient('admin');
    const employee = await portalClient('employee');
    await makeTicket({
      requesterId: employee.user.id,
      createdAt: new Date(Date.now() - DAY),
      responseDueAt: new Date(Date.now() + DAY)
    });
    await pool.query("UPDATE categories SET is_active = false WHERE name = 'Hardware'");

    const response = await admin.agent.get('/api/dashboard/category');
    expect(response.status).toBe(200);
    expect(response.body.data.find((row) => row.category === 'Hardware')).toEqual({
      category: 'Hardware',
      total: 1
    });
  });

  it('excludes cancelled tickets from resolution metrics', async () => {
    const admin = await portalClient('admin');
    const employee = await portalClient('employee');
    const agent = await portalClient('agent');
    const now = Date.now();
    const ticket = await makeTicket({
      status: 'New', requesterId: employee.user.id, assigneeId: agent.user.id,
      createdAt: new Date(now - 10 * DAY), responseDueAt: new Date(now + DAY)
    });

    const cancelled = await employee.agent
      .post(`/api/tickets/${ticket.id}/cancel`)
      .set(csrfHeader(employee))
      .send({});
    expect(cancelled.status).toBe(200);

    const overview = await admin.agent.get('/api/dashboard/overview?weeks=2');
    expect(overview.status).toBe(200);
    expect(overview.body.data.summary).toMatchObject({
      total: 1, open: 0, resolved: 0, closed: 0, cancelled: 1, overdue: 0
    });
    expect(overview.body.data.averageResolutionTime).toEqual({
      resolvedTickets: 0, averageResolutionMinutes: 0
    });
    expect(overview.body.data.weeklyTrends.reduce((sum, row) => sum + row.resolved, 0)).toBe(0);
    expect(overview.body.data.agentWorkload.find((row) => row.id === agent.user.id)).toMatchObject({
      assigned: 1, completed: 0
    });
  });

  it('stops treating a reopened cancelled ticket as cancelled', async () => {
    const admin = await portalClient('admin');
    const employee = await portalClient('employee');
    const now = Date.now();
    const ticket = await makeTicket({
      requesterId: employee.user.id,
      createdAt: new Date(now - DAY), responseDueAt: new Date(now + DAY)
    });

    const cancelled = await employee.agent
      .post(`/api/tickets/${ticket.id}/cancel`)
      .set(csrfHeader(employee))
      .send({});
    expect(cancelled.status).toBe(200);

    const reopened = await employee.agent
      .post(`/api/tickets/${ticket.id}/reopen`)
      .set(csrfHeader(employee))
      .send({});
    expect(reopened.status).toBe(200);

    const summary = await admin.agent.get('/api/dashboard/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.data).toMatchObject({ cancelled: 0, closed: 0, open: 1 });
  });

  it('keeps resolution history in trends and timing after a ticket is reopened', async () => {
    const admin = await portalClient('admin');
    const employee = await portalClient('employee');
    const { rows } = await pool.query("SELECT date_trunc('week', now()) AS week_start");
    const weekStart = rows[0].week_start.getTime();
    const ticket = await makeTicket({
      status: 'Resolved', requesterId: employee.user.id,
      createdAt: new Date(weekStart - 8 * DAY),
      resolvedAt: new Date(weekStart + DAY),
      responseDueAt: new Date(weekStart - 7 * DAY)
    });

    const before = await admin.agent.get('/api/dashboard/overview?weeks=2');
    expect(before.status).toBe(200);
    expect(before.body.data.weeklyTrends.map((row) => row.resolved)).toEqual([0, 1]);
    expect(before.body.data.averageResolutionTime).toEqual({
      resolvedTickets: 1,
      averageResolutionMinutes: 12960
    });

    const reopened = await employee.agent
      .post(`/api/tickets/${ticket.id}/reopen`)
      .set(csrfHeader(employee))
      .send({});
    expect(reopened.status).toBe(200);

    const after = await admin.agent.get('/api/dashboard/overview?weeks=2');
    expect(after.status).toBe(200);
    expect(after.body.data.summary).toMatchObject({ resolved: 0, open: 1 });
    expect(after.body.data.weeklyTrends.map((row) => row.resolved)).toEqual([0, 1]);
    expect(after.body.data.averageResolutionTime).toEqual({
      resolvedTickets: 1,
      averageResolutionMinutes: 12960
    });
  });

  it('counts a resolution after a cancelled ticket is reopened', async () => {
    const admin = await portalClient('admin');
    const employee = await portalClient('employee');
    const agent = await portalClient('agent');
    const ticket = await makeTicket({
      status: 'New',
      requesterId: employee.user.id,
      createdAt: new Date(Date.now() - DAY),
      responseDueAt: new Date(Date.now() + DAY)
    });

    const cancelled = await employee.agent
      .post(`/api/tickets/${ticket.id}/cancel`)
      .set(csrfHeader(employee))
      .send({});
    expect(cancelled.status).toBe(200);

    const reopened = await employee.agent
      .post(`/api/tickets/${ticket.id}/reopen`)
      .set(csrfHeader(employee))
      .send({});
    expect(reopened.status).toBe(200);

    const resolved = await agent.agent
      .patch(`/api/tickets/${ticket.id}/status`)
      .set(csrfHeader(agent))
      .send({ status: 'Resolved', resolutionNotes: 'Resolved after being reopened' });
    expect(resolved.status).toBe(200);

    const overview = await admin.agent.get('/api/dashboard/overview?weeks=2');
    expect(overview.status).toBe(200);
    expect(overview.body.data.summary).toMatchObject({
      total: 1, resolved: 1, closed: 0, cancelled: 0
    });
    expect(overview.body.data.weeklyTrends.reduce((sum, row) => sum + row.resolved, 0)).toBe(1);
    expect(overview.body.data.averageResolutionTime.resolvedTickets).toBe(1);
  });

  it('requires authentication for dashboard data', async () => {
    const client = await createClient(app);
    expect((await client.agent.get('/api/dashboard/overview')).status).toBe(401);
  });

  it('validates overview weeks and matches the individual endpoints', async () => {
    const admin = await portalClient('admin');
    const employee = await portalClient('employee');
    await makeTicket({
      requesterId: employee.user.id,
      createdAt: new Date(Date.now() - DAY),
      responseDueAt: new Date(Date.now() + DAY)
    });

    expect((await admin.agent.get('/api/dashboard/overview?weeks=0x10')).status).toBe(400);
    expect((await admin.agent.get('/api/dashboard/overview?weeks=abc')).status).toBe(400);

    const overview = await admin.agent.get('/api/dashboard/overview?weeks=4');
    expect(overview.status).toBe(200);

    const pairs = [
      ['summary', '/summary'],
      ['priority', '/priority'],
      ['category', '/category'],
      ['weeklyTrends', '/weekly-trends?weeks=4'],
      ['agentWorkload', '/agent-workload'],
      ['averageResolutionTime', '/average-resolution-time']
    ];
    for (const [key, path] of pairs) {
      const individual = await admin.agent.get(`/api/dashboard${path}`);
      expect(individual.status).toBe(200);
      expect(individual.body.data).toEqual(overview.body.data[key]);
    }
  });

  it('exposes individual dashboard endpoints with validated week windows', async () => {
    const admin = await portalClient('admin');
    const employee = await portalClient('employee');
    await makeTicket({
      requesterId: employee.user.id,
      createdAt: new Date(Date.now() - DAY),
      responseDueAt: new Date(Date.now() + DAY)
    });

    for (const path of [
      '/summary', '/priority', '/category',
      '/weekly-trends', '/agent-workload', '/average-resolution-time'
    ]) {
      expect((await admin.agent.get(`/api/dashboard${path}`)).status).toBe(200);
    }

    expect((await admin.agent.get('/api/dashboard/weekly-trends?weeks=0')).status).toBe(400);
    expect((await admin.agent.get('/api/dashboard/weekly-trends?weeks=53')).status).toBe(400);
    expect((await admin.agent.get('/api/dashboard/weekly-trends?weeks=abc')).status).toBe(400);
  });
});
