import { afterEach, describe, expect, it, vi } from 'vitest';

const originalSmtpFrom = process.env.SMTP_FROM;
const originalJwtExpiresIn = process.env.JWT_EXPIRES_IN;
const originalNodeEnv = process.env.NODE_ENV;
const originalJwtSecret = process.env.JWT_SECRET;
const originalAppDatabasePassword = process.env.APP_DATABASE_PASSWORD;

afterEach(() => {
  if (originalSmtpFrom === undefined) delete process.env.SMTP_FROM;
  else process.env.SMTP_FROM = originalSmtpFrom;
  if (originalJwtExpiresIn === undefined) delete process.env.JWT_EXPIRES_IN;
  else process.env.JWT_EXPIRES_IN = originalJwtExpiresIn;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
  if (originalAppDatabasePassword === undefined) delete process.env.APP_DATABASE_PASSWORD;
  else process.env.APP_DATABASE_PASSWORD = originalAppDatabasePassword;
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
