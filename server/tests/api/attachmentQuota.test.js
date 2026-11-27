import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    env: {
      ...actual.env,
      AV_ENABLED: true,
      TICKET_UPLOAD_QUOTA_BYTES: 20,
      USER_UPLOAD_QUOTA_BYTES: 1000
    }
  };
});

const { createApp } = await import('../../src/app.js');
const { pool } = await import('../../src/db/pool.js');
const { runMigrations } = await import('../../src/db/migrate.js');
const { seedReferenceData } = await import('../../src/db/seed.js');
const { resetDatabase } = await import('../helpers/db.js');
const { csrfHeader, loginClient } = await import('../helpers/api.js');
const { createTestUser } = await import('../helpers/users.js');

let uploadDirectory;
let scanner;
let app;

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await resetDatabase();
  await seedReferenceData(pool, { includeBootstrapUsers: false });
  uploadDirectory = await mkdtemp(join(tmpdir(), 'helpdesk-quota-'));
  scanner = vi.fn().mockResolvedValue({ enabled: true, clean: true });
  app = createApp({ uploadDirectory, notifier: null, attachmentScanner: scanner });
});

afterEach(async () => {
  await rm(uploadDirectory, { recursive: true, force: true });
});

async function setup() {
  const user = await createTestUser({ role: 'employee' });
  const client = await loginClient(app, user.email, user.password);
  const { rows: categories } = await pool.query("SELECT id FROM categories WHERE name = 'Hardware'");
  const { rows: subcategories } = await pool.query("SELECT id FROM subcategories WHERE name = 'Laptop / Desktop'");
  const created = await client.agent
    .post('/api/tickets')
    .set(csrfHeader(client))
    .send({
      title: 'Attachment quota ticket',
      description: 'Checking attachment quota enforcement.',
      categoryId: categories[0].id,
      subcategoryId: subcategories[0].id,
      priority: 'High'
    });
  expect(created.status).toBe(201);
  return { client, ticketId: created.body.data.ticket.id };
}

function upload(client, ticketId, contents) {
  return client.agent
    .post(`/api/tickets/${ticketId}/attachments`)
    .set(csrfHeader(client))
    .attach('file', Buffer.from(contents), { filename: 'notes.txt', contentType: 'text/plain' });
}

describe('attachment quotas and virus scanning', () => {
  it('rejects an upload that would exceed the ticket quota', async () => {
    const { client, ticketId } = await setup();
    expect((await upload(client, ticketId, '1234567890')).status).toBe(201);
    const rejected = await upload(client, ticketId, '123456789012345');

    expect(rejected.status).toBe(422);
    expect(rejected.body.error.message).toMatch(/quota/i);
    const { rows } = await pool.query(
      'SELECT id FROM attachments WHERE ticket_id = $1',
      [ticketId]
    );
    expect(rows).toHaveLength(1);
    expect(scanner).toHaveBeenCalledTimes(2);
  });

  it('rejects infected files without storing a file', async () => {
    const { client, ticketId } = await setup();
    scanner.mockResolvedValueOnce({ enabled: true, clean: false });

    const rejected = await upload(client, ticketId, 'infected');
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.message).toMatch(/virus scanner/i);
    expect(await readdir(uploadDirectory)).toEqual([]);
    const { rows } = await pool.query(
      'SELECT id FROM attachments WHERE ticket_id = $1',
      [ticketId]
    );
    expect(rows).toHaveLength(0);
  });
});
