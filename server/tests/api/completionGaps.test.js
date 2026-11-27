import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedReferenceData } from '../../src/db/seed.js';
import { resetDatabase } from '../helpers/db.js';
import { csrfHeader, loginClient } from '../helpers/api.js';
import { createTestUser } from '../helpers/users.js';

let uploadDirectory;
let app;

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDatabase();
  await seedReferenceData(pool, { includeBootstrapUsers: false });
  uploadDirectory = await mkdtemp(join(tmpdir(), 'helpdesk-completion-'));
  app = createApp({ uploadDirectory });
});

afterEach(async () => {
  await rm(uploadDirectory, { recursive: true, force: true });
});

async function clientFor(role) {
  const user = await createTestUser({ role, firstName: 'Completion', lastName: role });
  return { ...(await loginClient(app, user.email, user.password)), user };
}

async function catalog() {
  const { rows: categories } = await pool.query("SELECT id FROM categories WHERE name = 'Hardware'");
  const { rows: subcategories } = await pool.query(
    "SELECT id FROM subcategories WHERE name = 'Laptop / Desktop'"
  );
  return { categoryId: categories[0].id, subcategoryId: subcategories[0].id };
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
  expect(response.status).toBe(201);
  return response.body.data.ticket;
}

describe('audit log API', () => {
  it('is admin-only and supports filters and pagination', async () => {
    const employee = await clientFor('employee');
    const denied = await employee.agent.get('/api/audit-logs');
    expect(denied.status).toBe(403);

    const admin = await clientFor('admin');
    const requester = await clientFor('employee');
    await createTicket(requester);
    const listed = await admin.agent.get('/api/audit-logs?limit=2&page=1&action=ticket.created&entityType=ticket');
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toMatchObject({ action: 'ticket.created', entityType: 'ticket' });
    expect(listed.body.data[0].actorId).toBe(requester.user.id);
    expect(listed.body.meta).toMatchObject({ page: 1, limit: 2, total: 1, totalPages: 1 });
  });

  it('treats a date-only to filter as the whole named day', async () => {
    const admin = await clientFor('admin');
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);
    const createdAt = new Date(`${today}T14:00:00.000Z`);
    await pool.query(
      `INSERT INTO audit_logs (action, entity_type, entity_id, created_at)
       VALUES ('test.date_filter', 'ticket', 1, $1)`,
      [createdAt]
    );

    const listed = await admin.agent.get(`/api/audit-logs?action=test.date_filter&to=${today}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].action).toBe('test.date_filter');

    const reversed = await admin.agent.get(`/api/audit-logs?from=${today}&to=${yesterday}`);
    expect(reversed.status).toBe(400);
    expect(reversed.body.error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'from' })
    ]));
  });
});

describe('category administration', () => {
  it('creates, updates, disables and lists categories with audit records', async () => {
    const admin = await clientFor('admin');
    const created = await admin.agent
      .post('/api/categories')
      .set(csrfHeader(admin))
      .send({ name: 'Networking', description: 'Network equipment' });
    expect(created.status).toBe(201);
    expect(created.body.data.category).toMatchObject({ name: 'Networking', isActive: true });
    const categoryId = created.body.data.category.id;

    const sub = await admin.agent
      .post(`/api/categories/${categoryId}/subcategories`)
      .set(csrfHeader(admin))
      .send({ name: 'Router' });
    expect(sub.status).toBe(201);

    const updated = await admin.agent
      .patch(`/api/categories/${categoryId}`)
      .set(csrfHeader(admin))
      .send({ description: 'Updated description' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.category.description).toBe('Updated description');

    const disabled = await admin.agent
      .delete(`/api/categories/${categoryId}`)
      .set(csrfHeader(admin));
    expect(disabled.status).toBe(200);
    expect(disabled.body.data.category.isActive).toBe(false);

    const adminList = await admin.agent.get('/api/categories/admin?includeInactive=true&search=Networking');
    expect(adminList.status).toBe(200);
    expect(adminList.body.data.map((item) => item.id)).toContain(categoryId);

    const employee = await clientFor('employee');
    const publicList = await employee.agent.get('/api/categories');
    expect(publicList.status).toBe(200);
    expect(publicList.body.data.map((item) => item.id)).not.toContain(categoryId);

    const audit = await admin.agent.get('/api/audit-logs?entityType=category&limit=20');
    expect(audit.status).toBe(200);
    expect(audit.body.data.map((item) => item.action)).toEqual(expect.arrayContaining([
      'category.created', 'category.updated', 'category.deactivated'
    ]));

    const subAudit = await admin.agent.get('/api/audit-logs?entityType=subcategory&limit=20');
    expect(subAudit.body.data.map((item) => item.action)).toContain('subcategory.created');
  });

  it('denies category writes to non-admins', async () => {
    const employee = await clientFor('employee');
    const created = await employee.agent
      .post('/api/categories')
      .set(csrfHeader(employee))
      .send({ name: 'Unauthorized', description: 'Should fail' });
    expect(created.status).toBe(403);
  });
});

describe('ticket comment and history reads', () => {
  it('exposes paginated comments and history with role-aware filtering', async () => {
    const requester = await clientFor('employee');
    const agent = await clientFor('agent');
    const ticket = await createTicket(requester);
    const edited = await requester.agent
      .patch(`/api/tickets/${ticket.id}`)
      .set(csrfHeader(requester))
      .send({
        title: ticket.title,
        description: 'This (internal) word is part of my own description.'
      });
    expect(edited.status).toBe(200);

    const comment = await agent.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(agent))
      .send({ body: 'A public reply', isInternal: false });
    expect(comment.status).toBe(201);

    const internal = await agent.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(agent))
      .send({ body: 'A private note', isInternal: true });
    expect(internal.status).toBe(201);

    const employeeComments = await requester.agent.get(`/api/tickets/${ticket.id}/comments?limit=1&page=1`);
    expect(employeeComments.status).toBe(200);
    expect(employeeComments.body.data).toHaveLength(1);
    expect(employeeComments.body.meta.total).toBe(1);
    expect(employeeComments.body.data[0].body).toBe('A public reply');

    const staffComments = await agent.agent.get(`/api/tickets/${ticket.id}/comments`);
    expect(staffComments.body.data).toHaveLength(2);

    const employeeHistory = await requester.agent.get(`/api/tickets/${ticket.id}/history`);
    expect(employeeHistory.status).toBe(200);
    expect(employeeHistory.body.data.some((item) => item.action === 'internal_note_added')).toBe(false);
    expect(employeeHistory.body.data.some((item) => item.action === 'ticket_edited')).toBe(true);

    const otherRequester = await clientFor('employee');
    const forbidden = await otherRequester.agent.get(`/api/tickets/${ticket.id}/comments`);
    expect(forbidden.status).toBe(404);
  });
});

describe('attachment download alias', () => {
  it('downloads by attachment id with scoped authorization', async () => {
    const requester = await clientFor('employee');
    const ticket = await createTicket(requester);
    const uploaded = await requester.agent
      .post(`/api/tickets/${ticket.id}/attachments`)
      .set(csrfHeader(requester))
      .attach('file', Buffer.from('hello attachment'), { filename: 'note.txt', contentType: 'text/plain' });
    expect(uploaded.status).toBe(201);
    const attachmentId = uploaded.body.data.attachment.id;

    const downloaded = await requester.agent.get(`/api/attachments/${attachmentId}/download`);
    expect(downloaded.status).toBe(200);
    expect(Buffer.isBuffer(downloaded.body) ? downloaded.body.toString() : downloaded.text).toBe('hello attachment');

    const otherRequester = await clientFor('employee');
    const denied = await otherRequester.agent.get(`/api/attachments/${attachmentId}/download`);
    expect(denied.status).toBe(404);
  });
});

describe('resolution notes audit and demo flags', () => {
  it('audits notes on resolve and exposes isDemo on tickets and users', async () => {
    const requester = await clientFor('employee');
    const agent = await clientFor('agent');
    const ticket = await createTicket(requester);
    expect(ticket.isDemo).toBe(false);

    const resolved = await agent.agent
      .patch(`/api/tickets/${ticket.id}/status`)
      .set(csrfHeader(agent))
      .send({ status: 'Resolved', resolutionNotes: 'Fixed by replacing the battery' });
    expect(resolved.status).toBe(200);

    const history = await agent.agent.get(`/api/tickets/${ticket.id}/history`);
    expect(history.body.data.some((item) => item.action === 'resolution_notes_changed')).toBe(true);

    const audit = await agent.agent.get('/api/audit-logs?action=ticket.status_changed');
    expect(audit.status).toBe(403);

    const admin = await clientFor('admin');
    const adminAudit = await admin.agent.get('/api/audit-logs?action=ticket.status_changed');
    expect(adminAudit.status).toBe(200);
    expect(adminAudit.body.data[0].details.toNotes).toBe('Fixed by replacing the battery');

    const users = await admin.agent.get('/api/users?limit=5');
    expect(users.body.data.every((user) => typeof user.isDemo === 'boolean')).toBe(true);
  });
});

describe('production static hosting', () => {
  it('serves built assets and the SPA fallback without swallowing API 404s', async () => {
    const staticDirectory = await mkdtemp(join(tmpdir(), 'helpdesk-static-'));
    try {
      await writeFile(
        join(staticDirectory, 'index.html'),
        '<!doctype html><html><head><title>HelpDesk Pro</title></head><body><div id="root"></div></body></html>'
      );
      await writeFile(join(staticDirectory, 'asset.js'), 'console.log("built asset");');
      const staticApp = createApp({ uploadDirectory, staticDirectory, serveStatic: true });

      const asset = await request(staticApp).get('/asset.js');
      expect(asset.status).toBe(200);
      expect(asset.text).toContain('built asset');

      const deepLink = await request(staticApp).get('/tickets/42');
      expect(deepLink.status).toBe(200);
      expect(deepLink.text).toContain('HelpDesk Pro');

      const apiMissing = await request(staticApp).get('/api/does-not-exist');
      expect(apiMissing.status).toBe(404);
      expect(apiMissing.body.error.code).toBe('NOT_FOUND');
      expect(apiMissing.text).not.toContain('<div id="root"></div>');
    } finally {
      await rm(staticDirectory, { recursive: true, force: true });
    }
  });
});
