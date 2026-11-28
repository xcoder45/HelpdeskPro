import { env } from '../config/env.js';
import { pool } from './pool.js';
import { runMigrations } from './migrate.js';
import { seedReferenceData } from './seed.js';

export async function initializeDatabase({
  activePool = pool,
  runMigrationFn = runMigrations,
  seedReferenceFn = seedReferenceData,
  migrateOnStart = env.RUN_MIGRATIONS_ON_START,
  seedReferenceOnStart = env.SEED_REFERENCE_DATA_ON_START
} = {}) {
  if (seedReferenceOnStart && !migrateOnStart) {
    throw new Error('SEED_REFERENCE_DATA_ON_START requires RUN_MIGRATIONS_ON_START=true');
  }

  const result = { migrations: false, seed: false };

  if (migrateOnStart) {
    await runMigrationFn();
    result.migrations = true;
  }

  if (seedReferenceOnStart) {
    // Startup seeding is reference data only. Bootstrap/admin/demo users must
    // be created through the explicit, separately guarded seed commands.
    await seedReferenceFn(activePool, { includeBootstrapUsers: false });
    result.seed = true;
  }

  return result;
}
