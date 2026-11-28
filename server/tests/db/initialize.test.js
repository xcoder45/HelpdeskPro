import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    RUN_MIGRATIONS_ON_START: false,
    SEED_REFERENCE_DATA_ON_START: false
  },
  pool: { query: vi.fn(), end: vi.fn() },
  runMigrations: vi.fn(),
  seedReferenceData: vi.fn()
}));

vi.mock('../../src/config/env.js', () => ({ env: mocks.env }));
vi.mock('../../src/db/pool.js', () => ({ pool: mocks.pool }));
vi.mock('../../src/db/migrate.js', () => ({ runMigrations: mocks.runMigrations }));
vi.mock('../../src/db/seed.js', () => ({ seedReferenceData: mocks.seedReferenceData }));

const { initializeDatabase } = await import('../../src/db/initialize.js');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.RUN_MIGRATIONS_ON_START = false;
  mocks.env.SEED_REFERENCE_DATA_ON_START = false;
  mocks.runMigrations.mockResolvedValue([]);
  mocks.seedReferenceData.mockResolvedValue({ roles: 3 });
});

describe('startup database initialization', () => {
  it('does nothing when both startup flags are false', async () => {
    await expect(initializeDatabase()).resolves.toEqual({ migrations: false, seed: false });
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.seedReferenceData).not.toHaveBeenCalled();
  });

  it('runs migrations before reference seeding and never seeds bootstrap users', async () => {
    const result = await initializeDatabase({
      migrateOnStart: true,
      seedReferenceOnStart: true
    });

    expect(mocks.runMigrations).toHaveBeenCalledTimes(1);
    expect(mocks.seedReferenceData).toHaveBeenCalledWith(mocks.pool, { includeBootstrapUsers: false });
    expect(mocks.runMigrations.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.seedReferenceData.mock.invocationCallOrder[0]);
    expect(result).toEqual({ migrations: true, seed: true });
  });

  it('runs migrations alone when only the migration flag is enabled', async () => {
    const result = await initializeDatabase({ migrateOnStart: true });

    expect(mocks.runMigrations).toHaveBeenCalledTimes(1);
    expect(mocks.seedReferenceData).not.toHaveBeenCalled();
    expect(result).toEqual({ migrations: true, seed: false });
  });

  it('rejects seed-only configuration before touching the database', async () => {
    await expect(initializeDatabase({ seedReferenceOnStart: true }))
      .rejects.toThrow(/SEED_REFERENCE_DATA_ON_START/);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.seedReferenceData).not.toHaveBeenCalled();
  });

  it('does not seed when migration fails', async () => {
    mocks.runMigrations.mockRejectedValueOnce(new Error('migration failed'));

    await expect(initializeDatabase({ migrateOnStart: true, seedReferenceOnStart: true }))
      .rejects.toThrow('migration failed');
    expect(mocks.seedReferenceData).not.toHaveBeenCalled();
  });

  it('propagates seed failures', async () => {
    mocks.seedReferenceData.mockRejectedValueOnce(new Error('seed failed'));

    await expect(initializeDatabase({ migrateOnStart: true, seedReferenceOnStart: true }))
      .rejects.toThrow('seed failed');
  });
});
