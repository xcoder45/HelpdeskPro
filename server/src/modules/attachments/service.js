import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { env } from '../../config/env.js';
import { withTransaction } from '../../db/transaction.js';
import { recordAudit } from '../../services/audit.js';
import { scanBuffer } from '../../services/antivirus.js';
import { badRequest, forbidden, notFoundError, unprocessable } from '../../utils/errors.js';
import { findTicket, lockTicket } from '../tickets/service.js';

const STAFF_ROLES = ['agent', 'admin'];
const MAX_SIZE = env.MAX_UPLOAD_BYTES;
const EXTENSION_BY_MIME = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
};

function isStaff(actor) {
  return Boolean(actor && STAFF_ROLES.includes(actor.role));
}

function safeOriginalName(value) {
  const cleaned = String(value ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .trim();
  return (cleaned || 'attachment').slice(0, 255);
}

function validateUpload(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.size <= 0) {
    throw badRequest('Choose a non-empty file to upload');
  }
  if (file.size > MAX_SIZE) {
    throw badRequest(`Files must be ${Math.floor(MAX_SIZE / 1024 / 1024)} MiB or smaller`);
  }

  const mimeType = String(file.mimetype ?? '').trim();
  if (!mimeType || mimeType.length > 100 || /[\r\n]/.test(mimeType)) {
    throw badRequest('The file type could not be determined');
  }
  const expectedExtension = EXTENSION_BY_MIME[mimeType];
  if (!expectedExtension) {
    throw badRequest('This file type is not supported');
  }

  const originalName = safeOriginalName(file.originalname);
  const extension = originalName.includes('.') ? `.${originalName.split('.').pop().toLowerCase()}` : '';
  if (extension !== expectedExtension) {
    throw badRequest('The file extension does not match its type');
  }
  if (!contentsMatchType(file.buffer, mimeType)) {
    throw badRequest('The file contents do not match its type');
  }

  return {
    buffer: file.buffer,
    size: file.size,
    mimeType,
    originalName
  };
}

const ZIP_CENTRAL_HEADER = Buffer.from('PK\u0001\u0002');
const ZIP_EOCD = Buffer.from('PK\u0005\u0006');
const OLE2_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function findLastSignature(buffer, signature) {
  const earliest = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - signature.length; offset >= earliest; offset -= 1) {
    if (buffer.subarray(offset, offset + signature.length).equals(signature)) return offset;
  }
  return -1;
}

function zipHasEntries(buffer, requiredNames) {
  const eocd = findLastSignature(buffer, ZIP_EOCD);
  if (eocd < 0 || eocd + 22 > buffer.length) return false;

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries === 0 || totalEntries > 4096) return false;
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff) return false;
  if (centralOffset + centralSize > eocd) return false;

  const found = new Set();
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length) return false;
    if (!buffer.subarray(offset, offset + 4).equals(ZIP_CENTRAL_HEADER)) return false;

    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd + extraLength + commentLength > buffer.length) return false;

    found.add(buffer.toString('utf8', offset + 46, nameEnd));
    offset = nameEnd + extraLength + commentLength;
  }
  return requiredNames.every((name) => found.has(name));
}

function ole2HasEntry(buffer, name) {
  return buffer.includes(Buffer.from(`${name}\u0000`, 'utf16le'));
}

function contentsMatchType(buffer, mimeType) {
  if (mimeType === 'text/plain' || mimeType === 'text/csv') {
    const text = buffer.toString('utf8');
    return !text.includes('\u0000')
      && !text.includes('\uFFFD')
      && !/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text);
  }

  if (mimeType === 'application/msword') {
    return buffer.subarray(0, OLE2_SIGNATURE.length).equals(OLE2_SIGNATURE)
      && ole2HasEntry(buffer, 'WordDocument');
  }
  if (mimeType === 'application/vnd.ms-excel') {
    return buffer.subarray(0, OLE2_SIGNATURE.length).equals(OLE2_SIGNATURE)
      && (ole2HasEntry(buffer, 'Workbook') || ole2HasEntry(buffer, 'Book'));
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return buffer.subarray(0, 4).toString('ascii') === 'PK\u0003\u0004'
      && zipHasEntries(buffer, ['[Content_Types].xml', 'word/document.xml']);
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return buffer.subarray(0, 4).toString('ascii') === 'PK\u0003\u0004'
      && zipHasEntries(buffer, ['[Content_Types].xml', 'xl/workbook.xml']);
  }

  const signatures = {
    'image/png': [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    'image/jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
    'image/gif': [Buffer.from('GIF87a'), Buffer.from('GIF89a')],
    'image/webp': [Buffer.from('RIFF')],
    'application/pdf': [Buffer.from('%PDF-')]
  };
  const candidates = signatures[mimeType];
  if (!candidates) return false;
  return candidates.some((signature) => buffer.subarray(0, signature.length).equals(signature))
    && (mimeType !== 'image/webp' || buffer.subarray(8, 12).toString('ascii') === 'WEBP');
}

function storedFileName(mimeType) {
  return `${randomUUID()}${EXTENSION_BY_MIME[mimeType] ?? '.bin'}`;
}

async function quarantineRejectedFile(buffer, originalName, quarantineDirectory = env.AV_QUARANTINE_DIR) {
  try {
    const directory = resolve(quarantineDirectory);
    const suffix = safeOriginalName(originalName).split('.').pop().slice(0, 12);
    const name = `${randomUUID()}${suffix ? `.${suffix}` : ''}.quarantine`;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), buffer, { flag: 'wx' });
  } catch (error) {
    console.warn('[attachments] quarantine write failed:', error?.message ?? error);
  }
}

function resolveStoredPath(directory, storedName) {
  if (!/^[a-f0-9-]{36}(\.[a-z0-9]+)?$/.test(storedName)) {
    throw badRequest('Invalid stored attachment name');
  }
  return join(resolve(directory), storedName);
}

export function attachmentPath(directory, storedName) {
  return resolveStoredPath(resolve(directory), storedName);
}

export function formatAttachment(row) {
  return {
    id: Number(row.id),
    ticketId: Number(row.ticket_id),
    commentId: row.comment_id === null || row.comment_id === undefined
      ? null
      : Number(row.comment_id),
    uploaderId: Number(row.uploader_id),
    uploaderName: [row.first_name, row.last_name].filter(Boolean).join(' '),
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    isInternal: row.comment_is_internal === null || row.comment_is_internal === undefined
      ? false
      : Boolean(row.comment_is_internal),
    createdAt: row.created_at
  };
}

const ATTACHMENT_SELECT = `
  SELECT a.*, u.first_name, u.last_name, c.is_internal AS comment_is_internal
  FROM attachments a
  JOIN users u ON u.id = a.uploader_id
  LEFT JOIN comments c ON c.id = a.comment_id
`;

export async function listAttachments(database, ticketId, actor, query = {}) {
  await findTicket(database, ticketId, actor);
  const includeInternal = isStaff(actor);
  const visibility = includeInternal ? '' : ' AND (a.comment_id IS NULL OR c.is_internal = false)';
  const values = [ticketId];
  const addValue = (value) => {
    values.push(value);
    return `$${values.length}`;
  };
  const sortColumns = { createdAt: 'a.created_at', name: 'a.original_name', size: 'a.size_bytes' };
  const direction = query.order === 'desc' ? 'DESC' : 'ASC';
  const hasPagination = query.page !== undefined && query.limit !== undefined;
  let pagination = '';
  if (hasPagination) {
    pagination = ` LIMIT ${addValue(query.limit)} OFFSET ${addValue((query.page - 1) * query.limit)}`;
  }

  const { rows: countRows } = await database.query(
    `SELECT count(*)::int AS total
     FROM attachments a
     LEFT JOIN comments c ON c.id = a.comment_id
     WHERE a.ticket_id = $1${visibility}`,
    [ticketId]
  );
  const { rows } = await database.query(
    `${ATTACHMENT_SELECT}
     WHERE a.ticket_id = $1${visibility}
     ORDER BY ${sortColumns[query.sort] ?? sortColumns.createdAt} ${direction}, a.id ASC${pagination}`,
    values
  );
  return { attachments: rows.map(formatAttachment), total: countRows[0].total };
}

export async function uploadAttachment(
  database,
  ticketId,
  actor,
  file,
  ipAddress = null,
  {
    directory = env.UPLOAD_DIR,
    scanner = scanBuffer,
    avEnabled = env.AV_ENABLED,
    quarantineDirectory = env.AV_QUARANTINE_DIR
  } = {}
) {
  const upload = validateUpload(file);
  await findTicket(database, ticketId, actor);

  if (avEnabled) {
    let verdict;
    try {
      verdict = await scanner(upload.buffer);
    } catch (error) {
      await quarantineRejectedFile(upload.buffer, upload.originalName, quarantineDirectory);
      throw error;
    }
    if (!verdict?.clean) {
      await quarantineRejectedFile(upload.buffer, upload.originalName, quarantineDirectory);
      throw unprocessable('The file was rejected by the virus scanner');
    }
  }

  const storedName = storedFileName(upload.mimeType);
  const targetDirectory = resolve(directory);
  const storedPath = resolveStoredPath(targetDirectory, storedName);
  let written = false;

  try {
    return await withTransaction(database, async (client) => {
      const ticket = await lockTicket(client, ticketId, actor);
      if (ticket.status === 'Closed') {
        throw unprocessable('Closed tickets do not accept new attachments');
      }

      const { rows: usage } = await client.query(
        `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS bytes, count(*)::int AS files
         FROM attachments WHERE ticket_id = $1`,
        [ticketId]
      );
      if (Number(usage[0].bytes) + upload.size > env.TICKET_UPLOAD_QUOTA_BYTES) {
        throw unprocessable('This ticket has reached its attachment storage quota');
      }
      // Serialise quota checks for this uploader across different tickets.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('attachment_user_quota'), $1::integer)`,
        [Number(actor.id)]
      );
      const { rows: userUsage } = await client.query(
        `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS bytes
         FROM attachments WHERE uploader_id = $1`,
        [actor.id]
      );
      if (Number(userUsage[0].bytes) + upload.size > env.USER_UPLOAD_QUOTA_BYTES) {
        throw unprocessable('Your attachment storage quota has been reached');
      }

      await mkdir(targetDirectory, { recursive: true });
      await writeFile(storedPath, upload.buffer, { flag: 'wx' });
      written = true;

      const inserted = await client.query(
        `INSERT INTO attachments (
           ticket_id, uploader_id, original_name, stored_name, mime_type, size_bytes
         ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [ticketId, actor.id, upload.originalName, storedName, upload.mimeType, upload.size]
      );
      const attachmentId = inserted.rows[0].id;

      await client.query(
        `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, new_value)
         VALUES ($1, $2, 'attachment_added', 'attachment_id', $3::text)`,
        [ticketId, actor.id, String(attachmentId)]
      );

      await recordAudit(client, {
        actorId: actor.id,
        action: 'ticket.attachment_added',
        entityType: 'ticket',
        entityId: ticketId,
        details: {
          attachmentId: Number(attachmentId),
          originalName: upload.originalName,
          sizeBytes: upload.size
        },
        ipAddress
      });

      const { rows } = await client.query(`${ATTACHMENT_SELECT} WHERE a.id = $1`, [attachmentId]);
      return formatAttachment(rows[0]);
    });
  } catch (error) {
    if (written) await unlink(storedPath).catch(() => {});
    throw error;
  }
}

export async function getAttachmentForDownload(database, ticketId, attachmentId, actor, includeInternal = isStaff(actor)) {
  await findTicket(database, ticketId, actor);
  const visibility = includeInternal ? '' : ' AND (a.comment_id IS NULL OR c.is_internal = false)';
  const { rows } = await database.query(
    `${ATTACHMENT_SELECT}
     WHERE a.ticket_id = $1 AND a.id = $2${visibility}`,
    [ticketId, attachmentId]
  );
  if (rows.length === 0) throw notFoundError('Attachment not found');
  return { ...formatAttachment(rows[0]), storedName: rows[0].stored_name };
}

export async function getAttachmentById(database, attachmentId, actor, includeInternal = isStaff(actor)) {
  const { rows } = await database.query('SELECT ticket_id FROM attachments WHERE id = $1', [attachmentId]);
  if (rows.length === 0) throw notFoundError('Attachment not found');
  return getAttachmentForDownload(database, rows[0].ticket_id, attachmentId, actor, includeInternal);
}

export async function deleteAttachment(
  database,
  ticketId,
  attachmentId,
  actor,
  ipAddress = null,
  { directory = env.UPLOAD_DIR } = {}
) {
  const deleted = await withTransaction(database, async (client) => {
    const ticket = await lockTicket(client, ticketId, actor);
    if (ticket.status === 'Closed') {
      throw unprocessable('Closed tickets cannot be modified');
    }

    const visibility = isStaff(actor) ? '' : ' AND (a.comment_id IS NULL OR c.is_internal = false)';
    const { rows } = await client.query(
      `SELECT a.id, a.stored_name, a.uploader_id, a.original_name
       FROM attachments a
       LEFT JOIN comments c ON c.id = a.comment_id
       WHERE a.id = $1 AND a.ticket_id = $2${visibility}`,
      [attachmentId, ticketId]
    );
    if (rows.length === 0) throw notFoundError('Attachment not found');
    if (!isStaff(actor) && Number(rows[0].uploader_id) !== Number(actor.id)) {
      throw forbidden('You can only remove files that you uploaded');
    }

    await client.query('DELETE FROM attachments WHERE id = $1', [attachmentId]);

    await client.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value)
       VALUES ($1, $2, 'attachment_deleted', 'attachment_id', $3::text)`,
      [ticketId, actor.id, String(attachmentId)]
    );

    await recordAudit(client, {
      actorId: actor.id,
      action: 'ticket.attachment_deleted',
      entityType: 'ticket',
      entityId: ticketId,
      details: { attachmentId: Number(attachmentId), originalName: rows[0].original_name },
      ipAddress
    });

    return rows[0];
  });

  await unlink(resolveStoredPath(resolve(directory), deleted.stored_name)).catch((error) => {
    console.warn('[attachments] stored file cleanup failed', {
      attachmentId: Number(deleted.id),
      message: error?.message ?? error
    });
  });
  return { deleted: true };
}
