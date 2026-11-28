import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeDatabase: vi.fn(),
  createApp: vi.fn(),
  listen: vi.fn(),
  startRetentionJob: vi.fn(),
  stopRetentionJob: vi.fn(),
  closeRateLimitStore: vi.fn(),
  poolEnd: vi.fn()
}));

function registerMocks() {
  vi.doMock('../src/app.js', () => ({
    createApp: () => {
      mocks.createApp();
      return { listen: mocks.listen };
    }
  }));
  vi.doMock('../src/config/env.js', () => ({ env: { PORT: 3000 } }));
  vi.doMock('../src/db/pool.js', () => ({ pool: { end: mocks.poolEnd } }));
  vi.doMock('../src/db/initialize.js', () => ({ initializeDatabase: mocks.initializeDatabase }));
  vi.doMock('../src/jobs/retention.js', () => ({
    startRetentionJob: mocks.startRetentionJob,
    stopRetentionJob: mocks.stopRetentionJob
  }));
  vi.doMock('../src/services/rateLimitStore.js', () => ({ closeRateLimitStore: mocks.closeRateLimitStore }));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  registerMocks();
  mocks.poolEnd.mockResolvedValue(undefined);
  mocks.listen.mockImplementation((port, callback) => {
    callback?.();
    return { listening: false, close: (done) => done?.() };
  });
});

describe('server startup', () => {
  it('initializes the database before creating and starting Express', async () => {
    mocks.initializeDatabase.mockResolvedValue({ migrations: true, seed: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);

    try {
      await import('../src/server.js');
    } finally {
      logSpy.mockRestore();
      onSpy.mockRestore();
    }

    expect(mocks.initializeDatabase).toHaveBeenCalledWith({
      activePool: expect.objectContaining({ end: expect.any(Function) })
    });
    expect(mocks.createApp).toHaveBeenCalledTimes(1);
    expect(mocks.listen).toHaveBeenCalledWith(3000, expect.any(Function));
    expect(mocks.initializeDatabase.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createApp.mock.invocationCallOrder[0]);
    expect(mocks.createApp.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.listen.mock.invocationCallOrder[0]);
    expect(mocks.startRetentionJob).toHaveBeenCalledTimes(1);
    expect(mocks.poolEnd).not.toHaveBeenCalled();
  });

  it('does not start Express when database initialization fails', async () => {
    mocks.initializeDatabase.mockRejectedValue(new Error('init failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

    let exitCodes = [];
    try {
      await import('../src/server.js');
      exitCodes = exitSpy.mock.calls.map(([code]) => code);
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(mocks.initializeDatabase).toHaveBeenCalledTimes(1);
    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
    expect(exitCodes).toEqual([1]);
    expect(mocks.createApp).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.startRetentionJob).not.toHaveBeenCalled();
  });
});
