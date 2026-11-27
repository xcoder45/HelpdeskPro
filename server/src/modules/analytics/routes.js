import { Router } from 'express';
import { requireRole } from '../../middleware/roles.js';
import { validate } from '../../middleware/validate.js';
import { sendSuccess } from '../../utils/apiResponse.js';
import { weeklyTrendsQuerySchema } from './schemas.js';
import { getDashboardOverview, getSingleDashboardMetric } from './service.js';

export function createAnalyticsRouter({ database }) {
  const router = Router();
  const adminOnly = requireRole('admin');

  async function respondWithMetric(metric, weeks, res, next) {
    try {
      const data = await getSingleDashboardMetric(database, metric, weeks);
      return sendSuccess(res, data);
    } catch (error) {
      return next(error);
    }
  }

  router.get('/overview', adminOnly, validate(weeklyTrendsQuerySchema, 'query'), async (req, res, next) => {
    try {
      const data = await getDashboardOverview(database, req.validatedQuery.weeks);
      return sendSuccess(res, data);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/summary', adminOnly, (_req, res, next) => respondWithMetric('summary', 8, res, next));
  router.get('/priority', adminOnly, (_req, res, next) => respondWithMetric('priority', 8, res, next));
  router.get('/category', adminOnly, (_req, res, next) => respondWithMetric('category', 8, res, next));
  router.get(
    '/weekly-trends',
    adminOnly,
    validate(weeklyTrendsQuerySchema, 'query'),
    (req, res, next) => respondWithMetric('weeklyTrends', req.validatedQuery.weeks, res, next)
  );
  router.get('/agent-workload', adminOnly, (_req, res, next) => respondWithMetric('agentWorkload', 8, res, next));
  router.get(
    '/average-resolution-time',
    adminOnly,
    (_req, res, next) => respondWithMetric('averageResolutionTime', 8, res, next)
  );

  return router;
}
