import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createAuthRateLimiter } from '../../src/middleware/rateLimit.js';

function testApp() {
  const app = express();
  app.use(cookieParser());
  app.use(createAuthRateLimiter({ windowMs: 60_000, limit: 2, skip: () => false }));
  app.get('/test', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('authentication rate limiter', () => {
  it('returns 429 after the configured number of attempts', async () => {
    const agent = request.agent(testApp());

    expect((await agent.get('/test')).status).toBe(200);
    expect((await agent.get('/test')).status).toBe(200);

    const blocked = await agent.get('/test');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
  });
});
