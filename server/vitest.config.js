import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

const rootEnv = resolve(process.cwd(), '../.env');
if (existsSync(rootEnv)) config({ path: rootEnv });

if (!process.env.DATABASE_URL || !process.env.TEST_DATABASE_URL) {
  throw new Error('DATABASE_URL and TEST_DATABASE_URL are required to run tests');
}

const mainDatabase = new URL(process.env.DATABASE_URL).pathname;
const testDatabase = new URL(process.env.TEST_DATABASE_URL).pathname;
if (mainDatabase === testDatabase) {
  throw new Error('TEST_DATABASE_URL must point to a different database than DATABASE_URL');
}

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000
  }
});
