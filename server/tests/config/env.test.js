import { afterEach, describe, expect, it, vi } from 'vitest';

const originalSmtpFrom = process.env.SMTP_FROM;
const originalJwtExpiresIn = process.env.JWT_EXPIRES_IN;
const originalNodeEnv = process.env.NODE_ENV;
const originalJwtSecret = process.env.JWT_SECRET;
const originalAppDatabasePassword = process.env.APP_DATABASE_PASSWORD;
const vercelKeys = [
  'VERCEL_ENV',
  'REDIS_URL',
  'CRON_SECRET',
  'ATTACHMENT_STORAGE',
  'BLOB_STORE_ID',
  'BLOB_READ_WRITE_TOKEN',
  'AV_ENABLED',
  'CLAMAV_HOST',
  'DATABASE_POOL_MAX',
  'MAX_UPLOAD_BYTES'
];
const originalVercelEnv = Object.fromEntries(vercelKeys.map((key) => [key, process.env[key]]));

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnvironment('SMTP_FROM', originalSmtpFrom);
  restoreEnvironment('JWT_EXPIRES_IN', originalJwtExpiresIn);
  restoreEnvironment('NODE_ENV', originalNodeEnv);
  restoreEnvironment('JWT_SECRET', originalJwtSecret);
  restoreEnvironment('APP_DATABASE_PASSWORD', originalAppDatabasePassword);
  for (const key of vercelKeys) restoreEnvironment(key, originalVercelEnv[key]);
  vi.resetModules();
});

describe('SMTP_FROM configuration', () => {

  it('accepts a display-name sender as documented', async () => {
    process.env.SMTP_FROM = 'HelpDesk Pro <helpdesk@example.com>';
    const { env } = await import('../../src/config/env.js?smtp-display-name');
    expect(env.SMTP_FROM).toBe('HelpDesk Pro <helpdesk@example.com>');
  });

  it('rejects an invalid sender', async () => {
    process.env.SMTP_FROM = 'not-an-email';
    await expect(import('../../src/config/env.js?smtp-invalid')).rejects.toThrow(/SMTP_FROM/);
  });
});

describe('JWT_EXPIRES_IN configuration', () => {
  it('treats a unitless lifetime as seconds, matching the cookie lifetime', async () => {
    process.env.JWT_EXPIRES_IN = '60';
    const { env } = await import('../../src/config/env.js?jwt-seconds');
    expect(env.JWT_EXPIRES_IN).toBe('60s');
  });

  it('keeps explicit units and rejects invalid values', async () => {
    process.env.JWT_EXPIRES_IN = '12h';
    const { env } = await import('../../src/config/env.js?jwt-hours');
    expect(env.JWT_EXPIRES_IN).toBe('12h');

    process.env.JWT_EXPIRES_IN = '0';
    await expect(import('../../src/config/env.js?jwt-zero')).rejects.toThrow(/JWT_EXPIRES_IN/);
  });
});

describe('production JWT secret', () => {
  it('rejects the value published in .env.example', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'replace_with_a_random_secret_at_least_32_chars';
    await expect(import('../../src/config/env.js?jwt-example-secret')).rejects.toThrow(/JWT_SECRET/);
  });

  it('rejects another obvious placeholder that meets the length rule', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'local_dev_change_me_and_more_padding';
    await expect(import('../../src/config/env.js?jwt-placeholder-secret')).rejects.toThrow(/JWT_SECRET/);
  });

  it('accepts a non-placeholder production secret', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'b7f4c2a91e6d8305fa2c9471be603d8e';
    process.env.APP_DATABASE_PASSWORD = '9d1c2b7a4f8e6d30c5b2a17e4f9c8d60';
    const { env } = await import('../../src/config/env.js?jwt-production-secret');
    expect(env.NODE_ENV).toBe('production');
    expect(env.JWT_SECRET).toBe(process.env.JWT_SECRET);
  });
});

describe('production application database password', () => {
  it('rejects the local development placeholder', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'b7f4c2a91e6d8305fa2c9471be603d8e';
    process.env.APP_DATABASE_PASSWORD = 'local_dev_change_me';
    await expect(import('../../src/config/env.js?app-db-placeholder')).rejects.toThrow(/APP_DATABASE_PASSWORD/);
  });
});

describe('Vercel configuration', () => {
  function configureVercel() {
    process.env.NODE_ENV = 'production';
    process.env.VERCEL_ENV = 'production';
    process.env.JWT_SECRET = 'b7f4c2a91e6d8305fa2c9471be603d8e';
    process.env.APP_DATABASE_PASSWORD = '9d1c2b7a4f8e6d30c5b2a17e4f9c8d60';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.CRON_SECRET = 'd8e7c6b5a4938271f0e9d8c7b6a59483';
    process.env.ATTACHMENT_STORAGE = 'blob';
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_token_placeholder';
    process.env.AV_ENABLED = 'true';
    process.env.CLAMAV_HOST = 'clamd.example.com';
    process.env.MAX_UPLOAD_BYTES = '4194304';
  }

  it('accepts a complete deployment and applies serverless defaults', async () => {
    configureVercel();
    const { env } = await import('../../src/config/env.js?vercel-valid');

    expect(env.DATABASE_POOL_MAX).toBe(1);
    expect(env.MAX_UPLOAD_BYTES).toBe(4_194_304);
    expect(env.TRUST_PROXY_HOPS).toBe(1);
  });

  it.each([
    [
      'REDIS_URL',
      /REDIS_URL/,
      { REDIS_URL: undefined },
      () => import('../../src/config/env.js?vercel-redis')
    ],
    [
      'CRON_SECRET',
      /CRON_SECRET/,
      { CRON_SECRET: undefined },
      () => import('../../src/config/env.js?vercel-cron')
    ],
    [
      'blob storage',
      /ATTACHMENT_STORAGE/,
      { ATTACHMENT_STORAGE: 'local' },
      () => import('../../src/config/env.js?vercel-blob')
    ],
    [
      'antivirus',
      /AV_ENABLED/,
      { AV_ENABLED: 'false' },
      () => import('../../src/config/env.js?vercel-av')
    ],
    [
      'ClamAV host',
      /CLAMAV_HOST/,
      { CLAMAV_HOST: undefined },
      () => import('../../src/config/env.js?vercel-clamav')
    ]
  ])('requires %s', async (_label, messagePattern, overrides, load) => {
    configureVercel();
    for (const [key, value] of Object.entries(overrides)) restoreEnvironment(key, value);
    await expect(load()).rejects.toThrow(messagePattern);
  });
});
