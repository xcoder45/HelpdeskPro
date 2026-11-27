import { timingSafeEqual } from 'node:crypto';
import { forbidden } from '../utils/errors.js';
import { generateCsrfToken, setCsrfCookie } from '../utils/cookies.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function tokensMatch(cookieToken, headerToken) {
  if (typeof cookieToken !== 'string' || typeof headerToken !== 'string') return false;
  const cookieBuffer = Buffer.from(cookieToken, 'utf8');
  const headerBuffer = Buffer.from(headerToken, 'utf8');
  if (cookieBuffer.length !== headerBuffer.length) return false;
  return timingSafeEqual(cookieBuffer, headerBuffer);
}

export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    if (!req.cookies?.csrf_token) {
      const token = generateCsrfToken();
      setCsrfCookie(res, token);
      req.cookies = { ...req.cookies, csrf_token: token };
    }
    return next();
  }

  const headerToken = req.get('x-csrf-token');
  if (!tokensMatch(req.cookies?.csrf_token, headerToken)) {
    return next(forbidden('Missing or invalid CSRF token'));
  }

  return next();
}
