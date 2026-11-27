import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { uploadAttachment } from '../../src/modules/attachments/service.js';
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
  uploadDirectory = await mkdtemp(join(tmpdir(), 'helpdesk-attachments-'));
  app = createApp({ uploadDirectory, notifier: null });
});

afterEach(async () => {
  await rm(uploadDirectory, { recursive: true, force: true });
});

async function portalClient(role = 'employee', firstName = 'Attach') {
  const user = await createTestUser({ role, firstName, lastName: role });
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
      title: 'Keyboard keys are sticking',
      description: 'Several keys on the keyboard stick after being pressed.',
      categoryId: categories[0].id,
      subcategoryId: subcategories[0].id,
      priority: 'High'
    });
  expect(response.status).toBe(201);
  return response.body.data.ticket;
}

function zipBuffer(entryNames) {
  const localHeader = Buffer.from('PK\u0003\u0004');
  const centralHeaders = entryNames.map((name) => {
    const nameBytes = Buffer.from(name);
    const header = Buffer.alloc(46 + nameBytes.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(nameBytes.length, 28);
    nameBytes.copy(header, 46);
    return header;
  });
  const central = Buffer.concat(centralHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entryNames.length, 8);
  eocd.writeUInt16LE(entryNames.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localHeader.length, 16);
  return Buffer.concat([localHeader, central, eocd]);
}

function ole2Buffer(entryName) {
  const signature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const marker = Buffer.from(`${entryName}\u0000`, 'utf16le');
  return Buffer.concat([signature, Buffer.alloc(512), marker]);
}

describe('ticket attachments API', () => {
  it('uploads, lists, downloads, and deletes an attachment safely', async () => {
    const requester = await portalClient('employee', 'Requester');
    const agent = await portalClient('agent', 'Agent');
    const ticket = await createTicket(requester);

    const uploaded = await requester.agent
      .post(`/api/tickets/${ticket.id}/attachments`)
      .set(csrfHeader(requester))
      .attach('file', Buffer.from('diagnostic notes'), {
        filename: '../../diagnostic notes.txt',
        contentType: 'text/plain'
      });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.data.attachment).toMatchObject({
      ticketId: ticket.id,
      originalName: 'diagnostic notes.txt',
      mimeType: 'text/plain',
      sizeBytes: Buffer.byteLength('diagnostic notes')
    });
    expect(uploaded.body.data.attachment.storedName).toBeUndefined();

    const listed = await agent.agent.get(`/api/tickets/${ticket.id}/attachments`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].uploaderName).toBe('Requester employee');

    const attachmentId = uploaded.body.data.attachment.id;
    const download = await agent.agent.get(`/api/tickets/${ticket.id}/attachments/${attachmentId}/download`);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toMatch(/application\/octet-stream/);
    expect(download.headers['content-disposition']).toMatch(/attachment/);
    expect(Buffer.from(download.body).toString()).toBe('diagnostic notes');

    const deleted = await agent.agent
      .delete(`/api/tickets/${ticket.id}/attachments/${attachmentId}`)
      .set(csrfHeader(agent));
    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toEqual({ deleted: true });

    const afterDelete = await agent.agent.get(`/api/tickets/${ticket.id}/attachments`);
    expect(afterDelete.body.data).toEqual([]);
  });

  it('isolates attachments to the requester and hides internal-comment files', async () => {
    const owner = await portalClient('employee', 'Owner');
    const other = await portalClient('employee', 'Other');
    const agent = await portalClient('agent', 'Helper');
    const ticket = await createTicket(owner);

    const uploaded = await owner.agent
      .post(`/api/tickets/${ticket.id}/attachments`)
      .set(csrfHeader(owner))
      .attach('file', Buffer.from('public file'), { filename: 'public.txt', contentType: 'text/plain' });
    const attachmentId = uploaded.body.data.attachment.id;

    const comment = await agent.agent
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(csrfHeader(agent))
      .send({ body: 'Internal diagnosis', isInternal: true });
    expect(comment.status).toBe(201);
    const commentId = comment.body.data.comment.id;

    const { rows: inserted } = await pool.query(
      `INSERT INTO attachments (ticket_id, comment_id, uploader_id, original_name, stored_name, mime_type, size_bytes)
       VALUES ($1, $2, $3, 'internal.txt', $4, 'text/plain', 4) RETURNING id`,
      [ticket.id, commentId, agent.user.id, `${'a'.repeat(36)}.txt`]
    );
    const internalAttachmentId = Number(inserted[0].id);

    const ownerView = await owner.agent.get(`/api/tickets/${ticket.id}/attachments`);
    expect(ownerView.body.data.map((item) => item.id)).toEqual([attachmentId]);
    expect(ownerView.body.data[0].isInternal).toBe(false);

    const staffView = await agent.agent.get(`/api/tickets/${ticket.id}/attachments`);
    expect(staffView.body.data).toHaveLength(2);
    expect(staffView.body.data.find((item) => item.id === internalAttachmentId)?.isInternal).toBe(true);

    const internalDownload = await owner.agent
      .get(`/api/tickets/${ticket.id}/attachments/${internalAttachmentId}/download`);
    expect(internalDownload.status).toBe(404);

    expect((await other.agent.get(`/api/tickets/${ticket.id}/attachments`)).status).toBe(404);
    expect((await other.agent.get(`/api/tickets/${ticket.id}/attachments/${attachmentId}/download`)).status).toBe(404);
    expect((await other.agent
      .delete(`/api/tickets/${ticket.id}/attachments/${attachmentId}`)
      .set(csrfHeader(other))).status).toBe(404);

    const forbiddenDelete = await other.agent
      .delete(`/api/tickets/${ticket.id}/attachments/${attachmentId}`)
      .set(csrfHeader(other));
    expect(forbiddenDelete.status).toBe(404);
  });

  it('rejects oversized files and missing file parts', async () => {
    const requester = await portalClient();
    const ticket = await createTicket(requester);

    const missing = await requester.agent
      .post(`/api/tickets/${ticket.id}/attachments`)
      .set(csrfHeader(requester));
    expect(missing.status).toBe(400);

    const oversized = await requester.agent
      .post(`/api/tickets/${ticket.id}/attachments`)
      .set(csrfHeader(requester))
      .attach('file', Buffer.alloc(5_242_881, 'x'), { filename: 'huge.bin', contentType: 'application/octet-stream' });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects new attachments on closed tickets', async () => {
    const requester = await portalClient();
    const ticket = await createTicket(requester);
    await pool.query(
      `UPDATE tickets
       SET status = 'Closed', resolved_at = now(), closed_at = now(), resolution_notes = 'Done'
       WHERE id = $1`,
      [ticket.id]
    );

    const response = await requester.agent
      .post(`/api/tickets/${ticket.id}/attachments`)
      .set(csrfHeader(requester))
      .attach('file', Buffer.from('too late'), { filename: 'late.txt', contentType: 'text/plain' });

    expect(response.status).toBe(422);
    expect(response.body.error.message).toMatch(/closed tickets/i);
  });

  it('rejects attachment deletion on closed tickets for staff as well', async () => {
    const requester = await portalClient();
    const agent = await portalClient('agent', 'Closer');
    const ticket = await createTicket(requester);
    const uploaded = await requester.agent
      .post(`/api/tickets/${ticket.id}/attachments`)
      .set(csrfHeader(requester))
      .attach('file', Buffer.from('closed evidence'), { filename: 'evidence.txt', contentType: 'text/plain' });
    expect(uploaded.status).toBe(201);

    await pool.query(
      `UPDATE tickets
       SET status = 'Closed', resolved_at = now(), closed_at = now(), resolution_notes = 'Done'
       WHERE id = $1`,
      [ticket.id]
    );

    const response = await agent.agent
      .delete(`/api/tickets/${ticket.id}/attachments/${uploaded.body.data.attachment.id}`)
      .set(csrfHeader(agent));
    expect(response.status).toBe(422);
    expect(response.body.error.message).toMatch(/closed tickets/i);
  });

  it('rejects files whose bytes do not match an Office document type', async () => {
    const requester = await portalClient();
    const ticket = await createTicket(requester);
    const response = await requester.agent
      .post(`/api/tickets/${ticket.id}/attachments`)
      .set(csrfHeader(requester))
      .attach('file', Buffer.from('this is not an office document'), {
        filename: 'fake-report.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/contents do not match/i);
  });

  it('rejects a generic ZIP renamed as an Office document', async () => {
    const requester = await portalClient();
    const ticket = await createTicket(requester);
    const response = await requester.agent
      .post(`/api/tickets/${ticket.id}/attachments`)
      .set(csrfHeader(requester))
      .attach('file', zipBuffer(['notes.txt']), {
        filename: 'fake-report.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/contents do not match/i);
  });

  it('accepts ZIPs with the required Office document parts', async () => {
    const requester = await portalClient();
    const ticket = await createTicket(requester);
    const docx = await requester.agent
      .post(`/api/tickets/${ticket.id}/attachments`)
      .set(csrfHeader(requester))
      .attach('file', zipBuffer(['[Content_Types].xml', 'word/document.xml']), {
        filename: 'report.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      });
    const xlsx = await requester.agent
      .post(`/api/tickets/${ticket.id}/attachments`)
      .set(csrfHeader(requester))
      .attach('file', zipBuffer(['[Content_Types].xml', 'xl/workbook.xml']), {
        filename: 'report.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });

    expect(docx.status).toBe(201);
    expect(xlsx.status).toBe(201);
  });

  it('checks OLE2 directory markers for legacy Office files', async () => {
    const requester = await portalClient();
    const ticket = await createTicket(requester);
    const rejected = await requester.agent
      .post(`/api/tickets/${ticket.id}/attachments`)
      .set(csrfHeader(requester))
      .attach('file', ole2Buffer('NotAWordFile'), {
        filename: 'legacy.doc',
        contentType: 'application/msword'
      });
    const accepted = await requester.agent
      .post(`/api/tickets/${ticket.id}/attachments`)
      .set(csrfHeader(requester))
      .attach('file', ole2Buffer('WordDocument'), {
        filename: 'legacy.doc',
        contentType: 'application/msword'
      });

    expect(rejected.status).toBe(400);
    expect(accepted.status).toBe(201);
  });

  it('quarantines files rejected by the virus scanner', async () => {
    const requester = await portalClient();
    const ticket = await createTicket(requester);
    const quarantineDirectory = await mkdtemp(join(tmpdir(), 'helpdesk-quarantine-'));

    try {
      await expect(uploadAttachment(
        pool,
        ticket.id,
        { id: requester.user.id, role: 'employee' },
        {
          originalname: 'infected.txt',
          mimetype: 'text/plain',
          size: Buffer.byteLength('infected payload'),
          buffer: Buffer.from('infected payload')
        },
        null,
        {
          directory: uploadDirectory,
          avEnabled: true,
          quarantineDirectory,
          scanner: async () => ({ clean: false })
        }
      )).rejects.toThrow(/virus scanner/i);

      const files = await readdir(quarantineDirectory);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.txt\.quarantine$/);
    } finally {
      await rm(quarantineDirectory, { recursive: true, force: true });
    }
  });
});
