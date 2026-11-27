import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { sendError } from '../utils/apiResponse.js';
import { authRateLimitStore, ticketRateLimitStore } from '../services/rateLimitStore.js';

const FIFTEEN_MINUTES = 15 * 60_000;

export function createAuthRateLimiter({
  windowMs = FIFTEEN_MINUTES,
  limit = 20,
  store = authRateLimitStore,
  skip
} = {}) {
  return rateLimit({
    windowMs,
    limit,
    ...(store ? { store } : {}),
    standardHeaders: true,
    legacyHeaders: false,
    skip: skip ?? (() => env.NODE_ENV === 'test'),
    handler: (_req, res) => sendError(
      res,
      429,
      'TOO_MANY_REQUESTS',
      'Too many authentication attempts. Please try again later.'
    )
  });
}

export const authRateLimiter = createAuthRateLimiter();

export function createUserRateLimiter({
  windowMs = 60_000,
  limit = 30,
  message = 'Too many requests. Please try again shortly.',
  store = ticketRateLimitStore,
  skip
} = {}) {
  return rateLimit({
    windowMs,
    limit,
    ...(store ? { store } : {}),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user?.id ?? 'anonymous'),
    skip: skip ?? (() => env.NODE_ENV === 'test'),
    handler: (_req, res) => sendError(res, 429, 'TOO_MANY_REQUESTS', message)
  });
}

export const ticketWriteRateLimiter = createUserRateLimiter({
  limit: 30,
  message: 'Too many ticket changes. Please try again shortly.'
});
