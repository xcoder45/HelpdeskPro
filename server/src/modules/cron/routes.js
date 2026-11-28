import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { env } from '../../config/env.js';
import { runRetention } from '../../jobs/retention.js';
import { sendSuccess } from '../../utils/apiResponse.js';
import { unauthorized } from '../../utils/errors.js';

function isAuthorized(authorization, secret) {
  if (typeof authorization !== 'string' || typeof secret !== 'string' || secret.length === 0) {
    return false;
  }

  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) return false;

  const provided = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Vercel Cron Jobs are unauthenticated GET requests from Vercel's scheduler.
 * The shared secret is the security boundary, so every request must present it.
 */
export function createCronRouter({
  database,
  secret = env.CRON_SECRET,
  runner = runRetention
} = {}) {
  const router = Router();

  router.get('/retention', async (req, res, next) => {
    if (!isAuthorized(req.get('authorization'), secret)) {
      return next(unauthorized('Invalid cron authorization'));
    }

    try {
      const result = await runner(database);
      return sendSuccess(res, { result });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
