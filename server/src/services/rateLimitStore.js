import { createClient } from 'redis';
import { RedisStore } from 'rate-limit-redis';
import { MemoryStore } from 'express-rate-limit';
import { env } from '../config/env.js';

const clients = new Set();
let defaultClient = null;
let warnedAboutFallback = false;

function prepareClient(client) {
  if (client.isOpen) return client;
  client.on?.('error', (error) => {
    console.warn('[rate-limit] Redis error:', error?.message ?? error);
  });
  client.connect().catch((error) => {
    console.warn('[rate-limit] Redis connection failed:', error?.message ?? error);
  });
  return client;
}

function getDefaultClient() {
  if (!env.REDIS_URL) return null;
  if (!defaultClient) {
    defaultClient = prepareClient(createClient({ url: env.REDIS_URL }));
    clients.add(defaultClient);
  }
  return defaultClient;
}

function warnFallback(error) {
  if (warnedAboutFallback) return;
  warnedAboutFallback = true;
  console.warn('[rate-limit] Redis unavailable; using in-memory limits:', error?.message ?? error);
}

/**
 * Uses Redis while it is healthy and transparently falls back to an in-memory
 * store on command errors. Each limiter gets its own instance so windowMs and
 * counters cannot be shared between limiters with different policies.
 */
class ResilientRateLimitStore {
  constructor(redisStore) {
    this.redisStore = redisStore;
    this.memoryStore = new MemoryStore();
  }

  async init(options) {
    try {
      await this.redisStore.init?.(options);
    } catch (error) {
      warnFallback(error);
    }
    this.memoryStore.init?.(options);
  }

  async increment(key) {
    try {
      return await this.redisStore.increment(key);
    } catch (error) {
      warnFallback(error);
      return this.memoryStore.increment(key);
    }
  }

  async decrement(key) {
    try {
      return await this.redisStore.decrement(key);
    } catch (error) {
      warnFallback(error);
      return this.memoryStore.decrement(key);
    }
  }

  async get(key) {
    try {
      return await this.redisStore.get?.(key);
    } catch (error) {
      warnFallback(error);
      return this.memoryStore.get(key);
    }
  }

  async resetKey(key) {
    try {
      await this.redisStore.resetKey?.(key);
    } catch (error) {
      warnFallback(error);
    }
    await this.memoryStore.resetKey(key);
  }

  async resetAll() {
    try {
      await this.redisStore.resetAll?.();
    } catch (error) {
      warnFallback(error);
    }
    await this.memoryStore.resetAll();
  }

  async shutdown() {
    await Promise.allSettled([
      this.redisStore.shutdown?.(),
      this.memoryStore.shutdown?.()
    ]);
  }
}

/**
 * Builds an express-rate-limit store backed by Redis with in-memory fallback.
 * When neither REDIS_URL nor an injected client/url is available, returns null
 * so callers use express-rate-limit's default in-memory store.
 */
export function createRedisRateLimitStore({
  client,
  url = env.REDIS_URL,
  prefix = 'helpdesk:rl:'
} = {}) {
  if (!client && !url) return null;

  let redisClient = client;
  if (!redisClient) {
    redisClient = url === env.REDIS_URL
      ? getDefaultClient()
      : prepareClient(createClient({ url }));
    if (redisClient !== defaultClient) clients.add(redisClient);
  } else if (redisClient !== defaultClient) {
    clients.add(redisClient);
  }
  prepareClient(redisClient);

  const redisStore = new RedisStore({
    prefix,
    sendCommand: (...args) => redisClient.sendCommand(args.map(String))
  });
  return { store: new ResilientRateLimitStore(redisStore), client: redisClient };
}

const authStore = createRedisRateLimitStore({ prefix: 'helpdesk:rl:auth:' });
const ticketStore = createRedisRateLimitStore({
  client: authStore?.client,
  prefix: 'helpdesk:rl:ticket:'
});

export const authRateLimitStore = authStore?.store ?? null;
export const ticketRateLimitStore = ticketStore?.store ?? null;

// Kept for callers that only need one shared store.
export const sharedRateLimitStore = authRateLimitStore;

export async function closeRateLimitStore() {
  await Promise.all([...clients].map(async (client) => {
    if (client.isOpen) await client.quit();
  }));
  clients.clear();
  defaultClient = null;
}
