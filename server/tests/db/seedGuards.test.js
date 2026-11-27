import { afterEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../../src/db/pool.js';

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    env: {
      ...actual.env,
      NODE_ENV: 'production',
      ALLOW_PRODUCTION_BOOTSTRAP_USERS: false,
      ALLOW_PRODUCTION_DEMO_DATA: false,
      SEED_DEMO_PASSWORD: 'Demo12345!'
    }
  };
});

const { env } = await import('../../src/config/env.js');
const { seedReferenceData } = await import('../../src/db/seed.js');
const { seedDemoData } = await import('../../src/db/seedDemo.js');

const originalBootstrapFlag = env.ALLOW_PRODUCTION_BOOTSTRAP_USERS;
const originalDemoFlag = env.ALLOW_PRODUCTION_DEMO_DATA;

afterEach(() => {
  env.ALLOW_PRODUCTION_BOOTSTRAP_USERS = originalBootstrapFlag;
  env.ALLOW_PRODUCTION_DEMO_DATA = originalDemoFlag;
});

describe('production seeding guards', () => {
  it('does not create bootstrap accounts in production by default', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const summary = await seedReferenceData(pool);
      expect(summary.usersInserted).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bootstrap users skipped in production'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('refuses to seed demo accounts in production by default', async () => {
    await expect(seedDemoData(pool)).rejects.toThrow(/disabled in production/);
  });

  it('does not enable demo seeding when only the bootstrap flag is set', async () => {
    env.ALLOW_PRODUCTION_BOOTSTRAP_USERS = true;
    env.ALLOW_PRODUCTION_DEMO_DATA = false;
    await expect(seedDemoData(pool)).rejects.toThrow(/ALLOW_PRODUCTION_DEMO_DATA/);
  });
});
