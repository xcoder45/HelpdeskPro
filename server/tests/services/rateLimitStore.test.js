import { describe, expect, it, vi } from 'vitest';
import { createRedisRateLimitStore } from '../../src/services/rateLimitStore.js';

describe('Redis rate-limit store adapter', () => {
  it('returns no shared store when Redis is not configured', () => {
    expect(createRedisRateLimitStore({ url: null })).toBeNull();
  });

  it('forwards commands to the injected Redis client', async () => {
    const sendCommand = vi.fn().mockResolvedValue('script-sha');
    const client = { isOpen: true, sendCommand };
    const { store } = createRedisRateLimitStore({ client, prefix: 'test:rl:' });

    await store.init({ windowMs: 60_000 });
    expect(sendCommand).toHaveBeenCalledWith(expect.arrayContaining(['SCRIPT']));

    await store.decrement('visitor');
    const command = sendCommand.mock.calls.at(-1)[0];
    expect(command).toEqual(expect.arrayContaining(['DECR', 'test:rl:visitor']));
  });

  it('keeps separate instances so differing windows are not overwritten', async () => {
    const client = { isOpen: true, sendCommand: vi.fn().mockResolvedValue('script-sha') };
    const auth = createRedisRateLimitStore({ client, prefix: 'test:auth:' });
    const ticket = createRedisRateLimitStore({ client, prefix: 'test:ticket:' });

    expect(auth.store).not.toBe(ticket.store);
    await auth.store.init({ windowMs: 900_000 });
    await ticket.store.init({ windowMs: 60_000 });
    expect(auth.store.redisStore.windowMs).toBe(900_000);
    expect(ticket.store.redisStore.windowMs).toBe(60_000);
  });

  it('falls back to memory when a Redis command fails', async () => {
    const client = {
      isOpen: true,
      sendCommand: vi.fn().mockRejectedValue(new Error('Redis unavailable'))
    };
    const { store } = createRedisRateLimitStore({ client, prefix: 'test:fallback:' });
    await store.init({ windowMs: 60_000 });

    const firstTotal = (await store.increment('visitor')).totalHits;
    const secondTotal = (await store.increment('visitor')).totalHits;

    expect(firstTotal).toBe(1);
    expect(secondTotal).toBe(2);
  });

  it('gives auth and ticket limiters distinct default stores', async () => {
    vi.resetModules();
    vi.doMock('redis', () => ({
      createClient: () => ({ isOpen: true, sendCommand: vi.fn().mockResolvedValue('script-sha') })
    }));
    vi.stubEnv('REDIS_URL', 'redis://fake-redis:6379');

    try {
      const module = await import('../../src/services/rateLimitStore.js');
      expect(module.authRateLimitStore).not.toBe(module.ticketRateLimitStore);
      expect(module.authRateLimitStore.redisStore.prefix).toBe('helpdesk:rl:auth:');
      expect(module.ticketRateLimitStore.redisStore.prefix).toBe('helpdesk:rl:ticket:');
    } finally {
      vi.doUnmock('redis');
      vi.unstubAllEnvs();
    }
  });
});
