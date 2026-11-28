import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';

const secret = 'cron_secret_for_tests_1234567890';
const database = { query: vi.fn() };
const runner = vi.fn();
const app = createApp({
  database,
  notifier: null,
  cronSecret: secret,
  retentionRunner: runner
});

describe('Vercel retention cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runner.mockResolvedValue({ auditLogsDeleted: 2, historyRowsDeleted: 1 });
  });

  it('runs retention when the bearer secret matches', async () => {
    const response = await request(app)
      .get('/api/cron/retention')
      .set('Authorization', `Bearer ${secret}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: { result: { auditLogsDeleted: 2, historyRowsDeleted: 1 } }
    });
    expect(runner).toHaveBeenCalledWith(database);
  });

  it('rejects requests without the secret', async () => {
    const response = await request(app).get('/api/cron/retention');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects an incorrect secret without running retention', async () => {
    const response = await request(app)
      .get('/api/cron/retention')
      .set('Authorization', `Bearer ${secret}x`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(runner).not.toHaveBeenCalled();
  });

  it('requires the bearer scheme', async () => {
    const response = await request(app)
      .get('/api/cron/retention')
      .set('Authorization', secret);

    expect(response.status).toBe(401);
    expect(runner).not.toHaveBeenCalled();
  });
});
