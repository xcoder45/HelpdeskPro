import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedReferenceData } from '../../src/db/seed.js';
import { resetDatabase, createTicket as insertTicket } from '../helpers/db.js';
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
  const user = await createTestUser({ role, firstName: 'Sla', lastName: role });
  const client = await loginClient(app, user.email, user.password);
  return { ...client, user };
}

async function makeTicket({
  priority = 'High',
  createdAt,
  responseDueAt,
  firstRespondedAt = null,
  status = 'New',
  resolvedAt = null,
  cancelledAt = null,
  requesterId
}) {
  const ticket = await insertTicket({
    priority,
    status,
    requesterId,
    responseDueAt: responseDueAt ?? new Date(Date.now() + 60 * 60_000),
    resolvedAt,
    resolutionNotes: resolvedAt ? 'Completed during SLA testing' : null,
    title: `SLA test ticket ${priority}`,
    description: 'A ticket used to verify SLA reporting calculations.'
  });
  await pool.query(
    `UPDATE tickets
     SET created_at = $2, response_due_at = $3, first_responded_at = $4,
         resolved_at = $5, cancelled_at = $6
     WHERE id = $1`,
    [ticket.id, createdAt, responseDueAt, firstRespondedAt, resolvedAt, cancelledAt]
  );
  return ticket;
}

describe('SLA administration and reporting API', () => {
  it('lists rules for admins and blocks non-admins', async () => {
    const admin = await portalClient('admin');
    const agent = await portalClient('agent');
    const employee = await portalClient();

    const rules = await admin.agent.get('/api/sla/rules');
    expect(rules.status).toBe(200);
    expect(rules.body.data.map((rule) => rule.priority)).toEqual(['Critical', 'High', 'Medium', 'Low']);
    expect(rules.body.data[1]).toMatchObject({ priority: 'High', responseMinutes: 240, isActive: true });

    expect((await agent.agent.get('/api/sla/rules')).status).toBe(403);
    expect((await employee.agent.get('/api/sla/rules')).status).toBe(403);
  });

  it('lets admins update response targets with an audit record', async () => {
    const admin = await portalClient('admin');
    const agent = await portalClient('agent');
    const { rows } = await pool.query("SELECT id FROM sla_rules WHERE priority = 'Critical'");
    const ruleId = rows[0].id;

    const updated = await admin.agent
      .patch(`/api/sla/rules/${ruleId}`)
      .set(csrfHeader(admin))
      .send({ responseMinutes: 45 });
    expect(updated.status).toBe(200);
    expect(updated.body.data.rule).toMatchObject({
      priority: 'Critical',
      responseMinutes: 45,
      isActive: true
    });

    const denied = await agent.agent
      .patch(`/api/sla/rules/${ruleId}`)
      .set(csrfHeader(agent))
      .send({ responseMinutes: 60 });
    expect(denied.status).toBe(403);

    const invalid = await admin.agent
      .patch(`/api/sla/rules/${ruleId}`)
      .set(csrfHeader(admin))
      .send({ responseMinutes: 0 });
    expect(invalid.status).toBe(400);

    const immutablePriority = await admin.agent
      .patch(`/api/sla/rules/${ruleId}`)
      .set(csrfHeader(admin))
      .send({ priority: 'Low', responseMinutes: 50 });
    expect(immutablePriority.status).toBe(400);

    const { rows: audits } = await pool.query(
      "SELECT action, details FROM audit_logs WHERE action = 'sla.rule_updated'"
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].details.to.responseMinutes).toBe(45);
  });

  it('prevents disabling the only active SLA rule for a priority', async () => {
    const admin = await portalClient('admin');
    const { rows } = await pool.query("SELECT id FROM sla_rules WHERE priority = 'Critical'");
    const ruleId = rows[0].id;

    const disabled = await admin.agent
      .patch(`/api/sla/rules/${ruleId}`)
      .set(csrfHeader(admin))
      .send({ isActive: false });
    expect(disabled.status).toBe(422);
    expect(disabled.body.error.code).toBe('UNPROCESSABLE');

    const { rows: after } = await pool.query('SELECT is_active FROM sla_rules WHERE id = $1', [ruleId]);
    expect(after[0].is_active).toBe(true);

    const { rows: audits } = await pool.query(
      "SELECT action FROM audit_logs WHERE action = 'sla.rule_updated'"
    );
    expect(audits).toHaveLength(0);
  });

  it('reports response compliance, breaches, and pending deadlines', async () => {
    const agent = await portalClient('agent');
    const employee = await portalClient();
    const now = Date.now();
    const hour = 60 * 60_000;

    await makeTicket({
      priority: 'High',
      createdAt: new Date(now - 3 * hour),
      responseDueAt: new Date(now - 2 * hour),
      firstRespondedAt: new Date(now - 2.5 * hour)
    });
    await makeTicket({
      priority: 'High',
      createdAt: new Date(now - 3 * hour),
      responseDueAt: new Date(now - 2 * hour),
      firstRespondedAt: new Date(now - 1 * hour)
    });
    const pending = await makeTicket({
      priority: 'Low',
      createdAt: new Date(now - 0.5 * hour),
      responseDueAt: new Date(now + 0.1 * hour)
    });

    const report = await agent.agent.get('/api/sla/report');
    expect(report.status).toBe(200);
    expect(report.body.data.summary).toMatchObject({
      totalTickets: 3,
      responded: 2,
      metResponse: 1,
      breached: 1,
      pendingResponse: 1,
      unverifiedResponse: 0,
      complianceRate: 50,
      averageResponseMinutes: 75
    });
    expect(report.body.meta).toMatchObject({ page: 1, total: 3, totalPages: 1 });
    expect(report.body.data.tickets.map((ticket) => ticket.id)).toContain(Number(pending.id));
    expect(report.body.data.tickets.find((ticket) => ticket.id === Number(pending.id))).toMatchObject({
      metResponse: false,
      isOverdue: false,
      responseMinutes: null
    });

    const filtered = await agent.agent.get('/api/sla/report?priority=Low');
    expect(filtered.body.data.summary.totalTickets).toBe(1);

    const badRange = await agent.agent.get('/api/sla/report?from=2026-12-01&to=2026-11-01');
    expect(badRange.status).toBe(400);

    const invalidDate = await agent.agent.get('/api/sla/report?from=2026-13-45');
    expect(invalidDate.status).toBe(400);
    expect(invalidDate.body.error.code).toBe('BAD_REQUEST');

    const zeroYear = await agent.agent.get('/api/sla/report?from=0000-01-01');
    expect(zeroYear.status).toBe(400);
    expect(zeroYear.body.error.code).toBe('BAD_REQUEST');

    expect((await employee.agent.get('/api/sla/report')).status).toBe(403);
  });

  it('filters the SLA report by created_at date boundaries', async () => {
    const agent = await portalClient('agent');

    await makeTicket({
      createdAt: new Date('2026-01-15T12:00:00.000Z'),
      responseDueAt: new Date('2026-01-15T13:00:00.000Z')
    });
    await makeTicket({
      createdAt: new Date('2026-02-15T12:00:00.000Z'),
      responseDueAt: new Date('2026-02-15T13:00:00.000Z')
    });

    const report = await agent.agent.get('/api/sla/report?from=2026-02-01&to=2026-02-28');
    expect(report.status).toBe(200);
    expect(report.body.data.summary.totalTickets).toBe(1);
    expect(report.body.data.tickets[0].createdAt).toContain('2026-02-15');
  });

  it('sorts the SLA report by the requested column and direction', async () => {
    const agent = await portalClient('agent');
    const now = Date.now();
    const hour = 60 * 60_000;

    const older = await makeTicket({
      priority: 'Low',
      createdAt: new Date(now - 3 * hour),
      responseDueAt: new Date(now - 2 * hour)
    });
    const newer = await makeTicket({
      priority: 'Critical',
      createdAt: new Date(now - hour),
      responseDueAt: new Date(now + hour)
    });

    const ascending = await agent.agent.get('/api/sla/report?sort=createdAt&order=asc');
    expect(ascending.status).toBe(200);
    expect(ascending.body.data.tickets.map((ticket) => ticket.id)).toEqual([
      Number(older.id),
      Number(newer.id)
    ]);

    const descending = await agent.agent.get('/api/sla/report?sort=createdAt&order=desc');
    expect(descending.body.data.tickets.map((ticket) => ticket.id)).toEqual([
      Number(newer.id),
      Number(older.id)
    ]);

    const byPriority = await agent.agent.get('/api/sla/report?sort=priority&order=asc');
    expect(byPriority.status).toBe(200);
    expect(byPriority.body.data.tickets.map((ticket) => ticket.priority)).toEqual(['Critical', 'Low']);

    const invalid = await agent.agent.get('/api/sla/report?sort=createdAt&order=sideways');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('BAD_REQUEST');
  });

  it('derives SLA status, remaining time and durations from ticket timestamps', async () => {
    const agent = await portalClient('agent');
    const now = Date.now();
    const hour = 60 * 60_000;

    const pending = await makeTicket({
      createdAt: new Date(now - 30 * 60_000),
      responseDueAt: new Date(now + 90 * 60_000)
    });
    const breached = await makeTicket({
      createdAt: new Date(now - 3 * hour),
      responseDueAt: new Date(now - hour)
    });
    const met = await makeTicket({
      createdAt: new Date(now - 3 * hour),
      responseDueAt: new Date(now - 2 * hour),
      firstRespondedAt: new Date(now - 2.5 * hour)
    });
    const unverified = await makeTicket({
      status: 'Resolved',
      createdAt: new Date(now - 4 * hour),
      responseDueAt: new Date(now - 3 * hour),
      resolvedAt: new Date(now - hour)
    });

    const detail = await agent.agent.get(`/api/tickets/${pending.id}`);
    expect(detail.body.data.ticket.sla.status).toBe('pending');
    expect(detail.body.data.ticket.sla.timeRemainingMinutes).toBeGreaterThan(80);
    expect(detail.body.data.ticket.sla.timeRemainingMinutes).toBeLessThanOrEqual(90);

    const listed = await agent.agent.get('/api/tickets');
    const byId = new Map(listed.body.data.map((ticket) => [ticket.id, ticket]));
    expect(byId.get(Number(breached.id)).sla).toMatchObject({
      status: 'breached',
      responseMinutes: null,
      resolutionMinutes: null
    });
    expect(byId.get(Number(breached.id)).sla.timeRemainingMinutes).toBeLessThan(0);
    expect(byId.get(Number(breached.id)).isOverdue).toBe(true);
    expect(byId.get(Number(met.id)).sla).toMatchObject({ status: 'met', responseMinutes: 30 });
    expect(byId.get(Number(unverified.id)).sla).toMatchObject({
      status: 'unverified',
      responseMinutes: null,
      resolutionMinutes: 180
    });
    expect(byId.get(Number(unverified.id)).isOverdue).toBe(false);
  });

  it('exposes derived SLA fields to employees on their own tickets', async () => {
    const employee = await portalClient();
    const now = Date.now();
    const hour = 60 * 60_000;

    const ticket = await makeTicket({
      requesterId: employee.user.id,
      status: 'Resolved',
      createdAt: new Date(now - 3 * hour),
      responseDueAt: new Date(now - 2 * hour),
      firstRespondedAt: new Date(now - 2.5 * hour),
      resolvedAt: new Date(now - hour)
    });

    const detail = await employee.agent.get(`/api/tickets/${ticket.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.ticket.sla).toMatchObject({
      status: 'met',
      timeRemainingMinutes: null,
      responseMinutes: 30,
      resolutionMinutes: 120
    });

    const listed = await employee.agent.get('/api/tickets');
    const ownTicket = listed.body.data.find((row) => Number(row.id) === Number(ticket.id));
    expect(ownTicket.sla).toMatchObject({
      status: 'met',
      timeRemainingMinutes: null,
      responseMinutes: 30,
      resolutionMinutes: 120
    });
  });

  it('does not report a resolution duration for cancelled tickets', async () => {
    const agent = await portalClient('agent');
    const now = Date.now();
    const hour = 60 * 60_000;
    const ticket = await makeTicket({
      status: 'Closed',
      createdAt: new Date(now - 3 * hour),
      responseDueAt: new Date(now - 2 * hour),
      firstRespondedAt: new Date(now - 2.5 * hour),
      resolvedAt: new Date(now - hour),
      cancelledAt: new Date(now - hour)
    });

    const detail = await agent.agent.get(`/api/tickets/${ticket.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.ticket.sla).toMatchObject({
      responseMinutes: 30,
      resolutionMinutes: null
    });
  });

  it('filters the SLA report by all derived response statuses', async () => {
    const agent = await portalClient('agent');
    const now = Date.now();
    const hour = 60 * 60_000;

    await makeTicket({
      createdAt: new Date(now - 3 * hour),
      responseDueAt: new Date(now - 2 * hour),
      firstRespondedAt: new Date(now - 2.5 * hour)
    });
    await makeTicket({
      createdAt: new Date(now - 3 * hour),
      responseDueAt: new Date(now - 2 * hour),
      firstRespondedAt: new Date(now - hour)
    });
    await makeTicket({
      createdAt: new Date(now - hour),
      responseDueAt: new Date(now + hour)
    });
    await makeTicket({
      createdAt: new Date(now - 3 * hour),
      responseDueAt: new Date(now - hour)
    });
    await makeTicket({
      status: 'Resolved',
      createdAt: new Date(now - 4 * hour),
      responseDueAt: new Date(now - 3 * hour),
      firstRespondedAt: new Date(now - 3.5 * hour),
      resolvedAt: new Date(now - 2 * hour)
    });
    await makeTicket({
      status: 'Resolved',
      createdAt: new Date(now - 4 * hour),
      responseDueAt: new Date(now - 3 * hour),
      resolvedAt: new Date(now - 2 * hour)
    });

    const fullReport = await agent.agent.get('/api/sla/report');
    expect(fullReport.body.data.summary).toMatchObject({
      breached: 2,
      pendingResponse: 1
    });

    const breached = await agent.agent.get('/api/sla/report?slaStatus=breached');
    expect(breached.body.data.summary.totalTickets).toBe(2);
    expect(breached.body.data.tickets.every((ticket) => ticket.slaStatus === 'breached')).toBe(true);

    const pending = await agent.agent.get('/api/sla/report?slaStatus=pending');
    expect(pending.body.data.summary.totalTickets).toBe(1);
    expect(pending.body.data.tickets[0].slaStatus).toBe('pending');
    expect(pending.body.data.tickets[0].metResponse).toBe(false);

    const met = await agent.agent.get('/api/sla/report?slaStatus=met');
    expect(met.body.data.summary.totalTickets).toBe(2);
    expect(met.body.data.tickets.every((ticket) => ticket.slaStatus === 'met')).toBe(true);
    expect(met.body.data.tickets.some((ticket) => ticket.status === 'Resolved')).toBe(true);

    const unverified = await agent.agent.get('/api/sla/report?slaStatus=unverified');
    expect(unverified.body.data.summary.totalTickets).toBe(1);
    expect(unverified.body.data.tickets[0]).toMatchObject({
      slaStatus: 'unverified',
      status: 'Resolved',
      metResponse: false,
      responseMinutes: null
    });
  });
});
