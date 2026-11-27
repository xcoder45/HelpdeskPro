import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function generateCsrfToken() {
  return randomBytes(32).toString('hex');
}

export function durationToMs(value) {
  const raw = String(value).trim();
  const numeric = /^\d+$/.exec(raw);
  if (numeric) return Number(raw) * 1000;

  const matched = /^(\d+)\s*(s|m|h|d)$/.exec(raw);
  if (!matched) return DAY_MS;

  const amount = Number(matched[1]);
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS };
  return amount * multipliers[matched[2]];
}

const baseCookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure: env.NODE_ENV === 'production',
  path: '/'
};

export function setAccessTokenCookie(res, token) {
  res.cookie('access_token', token, {
    ...baseCookieOptions,
    maxAge: durationToMs(env.JWT_EXPIRES_IN)
  });
}

export function clearAccessTokenCookie(res) {
  res.clearCookie('access_token', baseCookieOptions);
}

export function setCsrfCookie(res, token) {
  res.cookie('csrf_token', token, {
    ...baseCookieOptions,
    httpOnly: false,
    maxAge: DAY_MS
  });
}

export function clearCsrfCookie(res) {
  res.clearCookie('csrf_token', baseCookieOptions);
}
