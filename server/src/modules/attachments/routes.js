import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import multer from 'multer';
import { Router } from 'express';
import { env } from '../../config/env.js';
import { validate } from '../../middleware/validate.js';
import { sendSuccess } from '../../utils/apiResponse.js';
import { idParamSchema, positiveIdSchema } from '../../validation/common.js';
import { listAttachmentsQuerySchema } from './schemas.js';
import {
  attachmentPath,
  deleteAttachment,
  getAttachmentById,
  getAttachmentForDownload,
  listAttachments,
  uploadAttachment
} from './service.js';

const attachmentParamSchema = idParamSchema.extend({ attachmentId: positiveIdSchema });
const downloadParamSchema = idParamSchema.extend({ id: positiveIdSchema });
const MAX_SIZE = env.MAX_UPLOAD_BYTES;

async function sendAttachment(res, attachment, directory) {
  const filePath = attachmentPath(directory, attachment.storedName);
  await access(filePath);
  res.attachment(attachment.originalName);
  res.type('application/octet-stream');
  const stream = createReadStream(filePath);
  stream.on('error', () => res.destroy());
  return stream.pipe(res);
}

export function createAttachmentsRouter({
  database,
  writeRateLimiter,
  directory = env.UPLOAD_DIR,
  scanner
} = {}) {
  const router = Router({ mergeParams: true });
  const receiveFile = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_SIZE, files: 1 }
  }).single('file');

  function parseUpload(req, res, next) {
    return receiveFile(req, res, (error) => (error ? next(error) : next()));
  }

  router.get(
    '/',
    validate(idParamSchema, 'params'),
    validate(listAttachmentsQuerySchema, 'query'),
    async (req, res) => {
      const query = req.validatedQuery;
      const { attachments, total } = await listAttachments(
        database,
        req.validatedParams.id,
        req.user,
        query
      );
      return sendSuccess(res, attachments, 200, {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit)
      });
    }
  );

  router.post(
    '/',
    writeRateLimiter,
    validate(idParamSchema, 'params'),
    parseUpload,
    async (req, res) => {
      const attachment = await uploadAttachment(
        database,
        req.validatedParams.id,
        req.user,
        req.file,
        req.ip,
        { directory, ...(scanner ? { scanner } : {}) }
      );
      return sendSuccess(res, { attachment }, 201);
    }
  );

  router.get(
    '/:attachmentId/download',
    validate(attachmentParamSchema, 'params'),
    async (req, res, next) => {
      try {
        const { id, attachmentId } = req.validatedParams;
        const attachment = await getAttachmentForDownload(database, id, attachmentId, req.user);
        return await sendAttachment(res, attachment, directory);
      } catch (error) {
        return next(error);
      }
    }
  );

  router.delete(
    '/:attachmentId',
    writeRateLimiter,
    validate(attachmentParamSchema, 'params'),
    async (req, res) => {
      const { id, attachmentId } = req.validatedParams;
      const result = await deleteAttachment(database, id, attachmentId, req.user, req.ip, { directory });
      return sendSuccess(res, result);
    }
  );

  return router;
}

export function createAttachmentDownloadRouter({ database, directory = env.UPLOAD_DIR } = {}) {
  const router = Router();

  router.get(
    '/:id/download',
    validate(downloadParamSchema, 'params'),
    async (req, res, next) => {
      try {
        if (!database) throw new Error('Attachment download router requires a database');
        const attachment = await getAttachmentById(database, req.validatedParams.id, req.user);
        return await sendAttachment(res, attachment, directory);
      } catch (error) {
        return next(error);
      }
    }
  );

  return router;
}
