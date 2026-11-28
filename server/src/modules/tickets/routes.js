import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { requireRole } from '../../middleware/roles.js';
import { validate } from '../../middleware/validate.js';
import { ticketWriteRateLimiter } from '../../middleware/rateLimit.js';
import { notificationService } from '../../services/notification.js';
import { sendSuccess } from '../../utils/apiResponse.js';
import { idParamSchema } from '../../validation/common.js';
import { createAttachmentsRouter } from '../attachments/routes.js';
import {
  addStaffComment,
  addTicketComment,
  assignTicket,
  cancelOwnTicket,
  closeTicket,
  createTicket,
  editOwnTicket,
  findTicket,
  getTicketDetail,
  getTicketRecipients,
  getTicketSummary,
  listAssignableUsers,
  listTicketComments,
  listTicketHistory,
  listTickets,
  reopenOwnTicket,
  updateTicketPriority,
  updateTicketStatus
} from './service.js';
import {
  assignTicketSchema,
  commentSchema,
  createTicketSchema,
  editOwnTicketSchema,
  listCommentsQuerySchema,
  listHistoryQuerySchema,
  listTicketsQuerySchema,
  staffCommentSchema,
  updateTicketPrioritySchema,
  updateTicketStatusSchema
} from './schemas.js';

const STAFF_ROLES = ['agent', 'admin'];

export function createTicketsRouter({
  database = pool,
  writeRateLimiter = ticketWriteRateLimiter,
  notifier = notificationService,
  uploadDirectory = env.UPLOAD_DIR,
  attachmentScanner,
  attachmentStore
} = {}) {
  const router = Router();
  const employeeOnly = requireRole('employee');
  const staffOnly = requireRole(...STAFF_ROLES);

  router.use(requireRole('employee', ...STAFF_ROLES));

  async function notifyTicket(event, ticketId, roles, extra = {}) {
    if (!notifier) return;
    try {
      const ticket = await findTicket(database, ticketId, { id: 0, role: 'admin' });
      const recipients = await getTicketRecipients(database, ticket, roles);
      await notifier.send(event, { ticket, recipients, ...extra });
    } catch (error) {
      console.warn('[notifications] event skipped', event, error?.message ?? error);
    }
  }

  function validateCommentForRole(req, res, next) {
    const schema = STAFF_ROLES.includes(req.user.role) ? staffCommentSchema : commentSchema;
    return validate(schema)(req, res, next);
  }

  router.get('/summary', async (req, res) => {
    const summary = await getTicketSummary(database, req.user);
    return sendSuccess(res, summary);
  });

  router.get('/assignees', staffOnly, async (_req, res) => {
    const assignees = await listAssignableUsers(database);
    return sendSuccess(res, { assignees });
  });

  router.get('/', validate(listTicketsQuerySchema, 'query'), async (req, res) => {
    const query = req.validatedQuery;
    const { tickets, total } = await listTickets(database, req.user, query);
    return sendSuccess(res, tickets, 200, {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit))
    });
  });

  router.post('/', employeeOnly, writeRateLimiter, validate(createTicketSchema), async (req, res) => {
    const ticket = await createTicket(database, req.user.id, req.body, req.ip);
    await notifyTicket('ticket.created', ticket.id, ['requester']);
    return sendSuccess(res, { ticket }, 201);
  });

  router.use(
    '/:id/attachments',
    createAttachmentsRouter({
      database,
      writeRateLimiter,
      directory: uploadDirectory,
      ...(attachmentScanner ? { scanner: attachmentScanner } : {}),
      ...(attachmentStore ? { store: attachmentStore } : {})
    })
  );

  router.get('/:id', validate(idParamSchema, 'params'), async (req, res) => {
    const ticket = await getTicketDetail(database, req.validatedParams.id, req.user);
    return sendSuccess(res, { ticket });
  });

  router.patch(
    '/:id',
    employeeOnly,
    writeRateLimiter,
    validate(idParamSchema, 'params'),
    validate(editOwnTicketSchema),
    async (req, res) => {
      const ticket = await editOwnTicket(database, req.validatedParams.id, req.user, req.body, req.ip);
      return sendSuccess(res, { ticket });
    }
  );

  router.post(
    '/:id/cancel',
    employeeOnly,
    writeRateLimiter,
    validate(idParamSchema, 'params'),
    async (req, res) => {
      const ticket = await cancelOwnTicket(database, req.validatedParams.id, req.user, req.ip);
      await notifyTicket('ticket.cancelled', ticket.id, ['requester']);
      return sendSuccess(res, { ticket });
    }
  );

  router.post(
    '/:id/reopen',
    employeeOnly,
    writeRateLimiter,
    validate(idParamSchema, 'params'),
    async (req, res) => {
      const ticket = await reopenOwnTicket(database, req.validatedParams.id, req.user, req.ip);
      await notifyTicket('ticket.reopened', ticket.id, ['requester']);
      return sendSuccess(res, { ticket });
    }
  );

  router.get(
    '/:id/comments',
    validate(idParamSchema, 'params'),
    validate(listCommentsQuerySchema, 'query'),
    async (req, res) => {
      const query = req.validatedQuery;
      const { comments, total } = await listTicketComments(
        database,
        req.validatedParams.id,
        req.user,
        query
      );
      return sendSuccess(res, comments, 200, {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit)
      });
    }
  );

  router.get(
    '/:id/history',
    validate(idParamSchema, 'params'),
    validate(listHistoryQuerySchema, 'query'),
    async (req, res) => {
      const query = req.validatedQuery;
      const { history, total } = await listTicketHistory(
        database,
        req.validatedParams.id,
        req.user,
        query
      );
      return sendSuccess(res, history, 200, {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit)
      });
    }
  );

  router.post(
    '/:id/comments',
    writeRateLimiter,
    validate(idParamSchema, 'params'),
    validateCommentForRole,
    async (req, res) => {
      const ticketId = req.validatedParams.id;
      const isStaff = STAFF_ROLES.includes(req.user.role);
      const isInternal = isStaff && Boolean(req.body.isInternal);
      const comment = isStaff
        ? await addStaffComment(database, ticketId, req.user, req.body, req.ip)
        : await addTicketComment(database, ticketId, req.user, req.body.body, req.ip);

      if (!isStaff && !isInternal) {
        await notifyTicket('ticket.employee_replied', ticketId, ['staff']);
      } else if (!isInternal) {
        await notifyTicket('ticket.agent_replied', ticketId, ['requester']);
      }
      return sendSuccess(res, { comment }, 201);
    }
  );

  router.post('/:id/close', employeeOnly, writeRateLimiter, validate(idParamSchema, 'params'), async (req, res) => {
    const ticket = await closeTicket(database, req.validatedParams.id, req.user, req.ip);
    await notifyTicket('ticket.closed', ticket.id, ['requester']);
    return sendSuccess(res, { ticket });
  });

  router.patch(
    '/:id/assign',
    staffOnly,
    writeRateLimiter,
    validate(idParamSchema, 'params'),
    validate(assignTicketSchema),
    async (req, res) => {
      const ticket = await assignTicket(
        database,
        req.validatedParams.id,
        req.user,
        req.body,
        req.ip
      );
      if (req.body.assigneeId) {
        await notifyTicket('ticket.assigned', ticket.id, ['assignee']);
      }
      return sendSuccess(res, { ticket });
    }
  );

  router.patch(
    '/:id/status',
    staffOnly,
    writeRateLimiter,
    validate(idParamSchema, 'params'),
    validate(updateTicketStatusSchema),
    async (req, res) => {
      const result = await updateTicketStatus(
        database,
        req.validatedParams.id,
        req.user,
        req.body,
        req.ip
      );
      const { autoAssigned, ...ticket } = result;
      if (autoAssigned && ticket.assigneeId) {
        await notifyTicket('ticket.assigned', ticket.id, ['assignee']);
      }
      const event = {
        Resolved: 'ticket.resolved',
        Closed: 'ticket.closed'
      }[ticket.status] ?? 'ticket.status_changed';
      await notifyTicket(event, ticket.id, ['requester']);
      return sendSuccess(res, { ticket });
    }
  );

  router.patch(
    '/:id/priority',
    staffOnly,
    writeRateLimiter,
    validate(idParamSchema, 'params'),
    validate(updateTicketPrioritySchema),
    async (req, res) => {
      const ticket = await updateTicketPriority(
        database,
        req.validatedParams.id,
        req.user,
        req.body,
        req.ip
      );
      return sendSuccess(res, { ticket });
    }
  );

  return router;
}
