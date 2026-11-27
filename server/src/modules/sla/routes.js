import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { requireRole } from '../../middleware/roles.js';
import { ticketWriteRateLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { sendSuccess } from '../../utils/apiResponse.js';
import { getSlaReport, listSlaRules, updateSlaRule } from './service.js';
import { slaReportQuerySchema, slaRuleParamSchema, updateSlaRuleSchema } from './schemas.js';

export function createSlaRouter({
  database = pool,
  writeRateLimiter = ticketWriteRateLimiter
} = {}) {
  const router = Router();
  const adminOnly = requireRole('admin');
  const staffOnly = requireRole('agent', 'admin');

  router.get('/rules', adminOnly, async (_req, res) => {
    const rules = await listSlaRules(database);
    return sendSuccess(res, rules);
  });

  router.patch(
    '/rules/:id',
    adminOnly,
    writeRateLimiter,
    validate(slaRuleParamSchema, 'params'),
    validate(updateSlaRuleSchema),
    async (req, res) => {
      const rule = await updateSlaRule(database, req.validatedParams.id, req.user, req.body, req.ip);
      return sendSuccess(res, { rule });
    }
  );

  router.get('/report', staffOnly, validate(slaReportQuerySchema, 'query'), async (req, res) => {
    const query = req.validatedQuery;
    const { summary, tickets, total } = await getSlaReport(database, query);
    return sendSuccess(res, { summary, tickets }, 200, {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit))
    });
  });

  return router;
}
