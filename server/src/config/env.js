import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { z } from 'zod';

function findEnvFile(startDirectory) {
  let directory = startDirectory;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(directory, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

const localEnvFile = findEnvFile(process.cwd())
  ?? findEnvFile(dirname(fileURLToPath(import.meta.url)));

if (localEnvFile) {
  config({ path: localEnvFile });
}

const postgresUrl = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:';
  } catch {
    return false;
  }
}, 'must be a PostgreSQL connection URL');

const email = z.string().refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'must be an email address');
const smtpFrom = z.string().refine((value) => {
  const trimmed = value.trim();
  if (email.safeParse(trimmed).success) return true;
  const withDisplayName = /^[^<>]+<([^<>]+)>$/.exec(trimmed);
  return Boolean(withDisplayName && email.safeParse(withDisplayName[1]).success);
}, 'must be an email address or a display name such as "HelpDesk <helpdesk@example.com>"');
const booleanFromEnv = z.preprocess(
  (value) => value === undefined ? undefined : value === true || String(value).toLowerCase() === 'true',
  z.boolean()
);

function isPlaceholderJwtSecret(value) {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('replace_')
    || normalized.includes('_replace_')
    || normalized.startsWith('change_')
    || normalized.includes('_change_')
    || normalized.includes('placeholder')
    || normalized.includes('example_secret');
}

// jsonwebtoken interprets a unitless string as milliseconds, but cookie max-age as seconds.
// Normalising bare numbers to seconds keeps the token and cookie lifetimes identical.
const durationFromEnv = z.preprocess(
  (value) => typeof value === 'string' && /^\d+$/.test(value.trim()) ? `${value.trim()}s` : value,
  z.string().regex(/^[1-9]\d*(s|m|h|d)?$/, 'must be a positive duration such as 1d, 12h or 60')
);

const httpUrl = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an http or https URL');

const redisUrl = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'redis:' || parsed.protocol === 'rediss:';
  } catch {
    return false;
  }
}, 'must be a redis or rediss URL');

const vercelBaseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  VERCEL_ENV: z.enum(['development', 'preview', 'production']).optional(),
  VERCEL_URL: z.string().min(1).optional(),
  DATABASE_URL: postgresUrl,
  TEST_DATABASE_URL: postgresUrl.optional(),
  DATABASE_POOL_MAX: z.coerce.number()
    .int()
    .min(1)
    .max(100)
    .default(process.env.VERCEL_ENV ? 1 : 10),
  JWT_SECRET: z.string().min(16, 'must be at least 16 characters'),
  JWT_EXPIRES_IN: durationFromEnv.default('1d'),
  CRON_SECRET: z.string().min(16).optional(),
  TRUST_PROXY_HOPS: process.env.VERCEL_ENV
    ? z.coerce.number().int().min(0).default(1)
    : z.coerce.number().int().min(0).optional(),
  APP_BASE_URL: httpUrl.default(vercelBaseUrl ?? 'http://localhost:5173'),
  REQUIRE_EMAIL_VERIFICATION: booleanFromEnv.default(false),
  PASSWORD_RESET_TTL: durationFromEnv.default('1h'),
  EMAIL_VERIFICATION_TTL: durationFromEnv.default('24h'),
  REDIS_URL: redisUrl.optional(),
  RUN_MIGRATIONS_ON_START: booleanFromEnv.default(false),
  SEED_REFERENCE_DATA_ON_START: booleanFromEnv.default(false),
  RETENTION_ENABLED: booleanFromEnv.default(false),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).default(365),
  TICKET_HISTORY_RETENTION_DAYS: z.coerce.number().int().min(1).default(365),
  RETENTION_INTERVAL_MS: z.coerce.number().int().min(3_600_000).default(86_400_000),
  ATTACHMENT_STORAGE: z.enum(['local', 'blob']).default('local'),
  BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number()
    .int()
    .min(1024)
    .max(104_857_600)
    .default(process.env.VERCEL_ENV ? 4_194_304 : 5_242_880),
  TICKET_UPLOAD_QUOTA_BYTES: z.coerce.number().int().positive().default(52_428_800),
  USER_UPLOAD_QUOTA_BYTES: z.coerce.number().int().positive().default(104_857_600),
  AV_ENABLED: booleanFromEnv.default(false),
  CLAMAV_HOST: z.string().min(1).optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  AV_SCAN_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  AV_QUARANTINE_DIR: z.string().default('./quarantine'),
  NOTIFICATIONS_ENABLED: booleanFromEnv.default(true),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: booleanFromEnv.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: smtpFrom.optional(),
  POSTGRES_USER: z.string().optional(),
  POSTGRES_PASSWORD: z.string().optional(),
  POSTGRES_DB: z.string().optional(),
  APP_DATABASE_USER: z.string().regex(/^[a-z_][a-z0-9_]*$/).default('helpdesk_app'),
  APP_DATABASE_PASSWORD: z.string().min(1).default('local_dev_change_me'),
  SEED_ADMIN_EMAIL: email.optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
  SEED_AGENT_EMAIL: email.optional(),
  SEED_AGENT_PASSWORD: z.string().min(8).optional(),
  SEED_EMPLOYEE_EMAIL: email.optional(),
  SEED_EMPLOYEE_PASSWORD: z.string().min(8).optional(),
  SEED_DEMO_PASSWORD: z.string().min(8).optional(),
  ALLOW_PRODUCTION_BOOTSTRAP_USERS: booleanFromEnv.default(false),
  ALLOW_PRODUCTION_DEMO_DATA: booleanFromEnv.default(false)
}).refine(
  (data) => data.NODE_ENV !== 'production'
    || (data.JWT_SECRET.length >= 32 && !isPlaceholderJwtSecret(data.JWT_SECRET)),
  {
    path: ['JWT_SECRET'],
    message: 'must be a unique random value of at least 32 characters in production, not an example placeholder'
  }
).refine(
  (data) => data.NODE_ENV !== 'production' || !isPlaceholderJwtSecret(data.APP_DATABASE_PASSWORD),
  {
    path: ['APP_DATABASE_PASSWORD'],
    message: 'must be a unique database password in production, not an example placeholder'
  }
).refine(
  (data) => data.MAX_UPLOAD_BYTES <= data.TICKET_UPLOAD_QUOTA_BYTES
    && data.MAX_UPLOAD_BYTES <= data.USER_UPLOAD_QUOTA_BYTES,
  {
    path: ['MAX_UPLOAD_BYTES'],
    message: 'must not exceed TICKET_UPLOAD_QUOTA_BYTES or USER_UPLOAD_QUOTA_BYTES'
  }
).refine(
  (data) => {
    const path = relative(resolve(data.UPLOAD_DIR), resolve(data.AV_QUARANTINE_DIR));
    return path.startsWith('..') || isAbsolute(path);
  },
  {
    path: ['AV_QUARANTINE_DIR'],
    message: 'must be outside UPLOAD_DIR so rejected files are never confused with attachments'
  }
).refine(
  (data) => data.ATTACHMENT_STORAGE !== 'blob' || Boolean(data.BLOB_READ_WRITE_TOKEN),
  {
    path: ['ATTACHMENT_STORAGE'],
    message: 'blob storage requires BLOB_READ_WRITE_TOKEN'
  }
).refine(
  (data) => data.VERCEL_ENV !== 'production' || data.NODE_ENV === 'production',
  {
    path: ['NODE_ENV'],
    message: 'must be production when VERCEL_ENV=production so production secret rules apply'
  }
).refine(
  (data) => data.VERCEL_ENV !== 'production' || Boolean(data.CRON_SECRET),
  {
    path: ['CRON_SECRET'],
    message: 'must be set for Vercel production so scheduled retention is authenticated'
  }
).refine(
  (data) => !data.VERCEL_ENV || Boolean(data.REDIS_URL),
  {
    path: ['REDIS_URL'],
    message: 'must be set on Vercel so rate limits are shared across function instances'
  }
).refine(
  (data) => !data.VERCEL_ENV || data.ATTACHMENT_STORAGE === 'blob',
  {
    path: ['ATTACHMENT_STORAGE'],
    message: 'must be blob on Vercel because the function filesystem is not persistent'
  }
).refine(
  (data) => !data.VERCEL_ENV || data.AV_ENABLED,
  {
    path: ['AV_ENABLED'],
    message: 'must be enabled on Vercel so uploads retain malware scanning'
  }
).refine(
  (data) => !data.VERCEL_ENV || Boolean(data.CLAMAV_HOST),
  {
    path: ['CLAMAV_HOST'],
    message: 'must be set on Vercel to a network-reachable ClamAV service when AV_ENABLED=true'
  }
);

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('\n  - ');
  throw new Error(`Invalid environment configuration:\n  - ${problems}`);
}

export const env = Object.freeze(parsed.data);
