import { Router } from 'express';
import { requireRole } from '../../middleware/roles.js';
import { validate } from '../../middleware/validate.js';
import { idParamSchema } from '../../validation/common.js';
import { recordAudit } from '../../services/audit.js';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { sendError, sendSuccess } from '../../utils/apiResponse.js';
import { unprocessable } from '../../utils/errors.js';
import {
  createUserSchema,
  listUsersQuerySchema,
  updateMeSchema,
  updateUserSchema
} from './schemas.js';
import {
  createUserRecord,
  findUserById,
  formatUser,
  listUsers,
  updateUserRecord
} from './service.js';

export function createUsersRouter({ database = pool } = {}) {
  const router = Router();

  router.get('/me', (req, res) => sendSuccess(res, { user: req.user }));

  router.patch('/me', validate(updateMeSchema), async (req, res) => {
    const user = await withTransaction(database, async (client) => {
      const updated = await updateUserRecord(client, req.user.id, req.body);
      await recordAudit(client, {
        actorId: req.user.id,
        action: 'user.updated_self',
        entityType: 'user',
        entityId: req.user.id,
        details: { fields: Object.keys(req.body) },
        ipAddress: req.ip
      });
      return updated;
    });
    return sendSuccess(res, { user });
  });

  router.get('/', requireRole('admin'), validate(listUsersQuerySchema, 'query'), async (req, res) => {
    const query = req.validatedQuery;
    const { users, total } = await listUsers(database, query);
    return sendSuccess(res, users, 200, {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit)
    });
  });

  router.post('/', requireRole('admin'), validate(createUserSchema), async (req, res) => {
    const user = await withTransaction(database, async (client) => {
      const created = await createUserRecord(client, req.body);
      await recordAudit(client, {
        actorId: req.user.id,
        action: 'user.created',
        entityType: 'user',
        entityId: created.id,
        details: { role: created.role },
        ipAddress: req.ip
      });
      return created;
    });
    return sendSuccess(res, { user }, 201);
  });

  router.get('/:id', requireRole('admin'), validate(idParamSchema, 'params'), async (req, res) => {
    const row = await findUserById(database, req.validatedParams.id);
    if (!row) return sendError(res, 404, 'NOT_FOUND', 'User not found');
    return sendSuccess(res, { user: formatUser(row) });
  });

  router.patch('/:id', requireRole('admin'), validate(idParamSchema, 'params'), validate(updateUserSchema), async (req, res) => {
    const id = req.validatedParams.id;
    if (id === req.user.id && ('role' in req.body || req.body.isActive === false)) {
      throw unprocessable('You cannot change your own role or deactivate your own account');
    }

    const user = await withTransaction(database, async (client) => {
      const updated = await updateUserRecord(client, id, req.body);
      await recordAudit(client, {
        actorId: req.user.id,
        action: 'user.updated',
        entityType: 'user',
        entityId: updated.id,
        details: { fields: Object.keys(req.body) },
        ipAddress: req.ip
      });
      return updated;
    });
    return sendSuccess(res, { user });
  });

  return router;
}
