import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { requireRole } from '../../middleware/roles.js';
import { validate } from '../../middleware/validate.js';
import { sendSuccess } from '../../utils/apiResponse.js';
import { listAuditLogsQuerySchema } from './schemas.js';
import { listAuditLogs } from './service.js';

export function createAuditRouter({ database = pool } = {}) {
  const router = Router();

  router.get('/', requireRole('admin'), validate(listAuditLogsQuerySchema, 'query'), async (req, res) => {
    const query = req.validatedQuery;
    const { logs, total } = await listAuditLogs(database, query);
    return sendSuccess(res, logs, 200, {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit)
    });
  });

  return router;
}
