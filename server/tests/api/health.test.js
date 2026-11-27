import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('API foundation', () => {
  it('reports a healthy service with a working database connection', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: { status: 'ok', database: 'ok' }
    });
  });

  it('returns a consistent JSON envelope for unknown endpoints without echoing the URL', async () => {
    const response = await request(app).get('/api/does-not-exist?token=secret-value');
    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.message).toBe('Endpoint not found');
    expect(JSON.stringify(response.body)).not.toContain('secret-value');
  });

  it('sets security headers on API responses', async () => {
    const response = await request(app).get('/api/health');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('rejects malformed JSON without leaking an exception', async () => {
    const response = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_JSON');
    expect(JSON.stringify(response.body)).not.toContain('at Object');
  });

  it('marks API responses as non-cacheable', async () => {
    const healthy = await request(app).get('/api/health');
    const missing = await request(app).get('/api/not-cached');

    expect(healthy.headers['cache-control']).toBe('no-store');
    expect(missing.headers['cache-control']).toBe('no-store');
  });
});
