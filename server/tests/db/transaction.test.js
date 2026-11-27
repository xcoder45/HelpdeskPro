import { describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../../src/db/transaction.js';

function fakeDatabase({ failWork = false } = {}) {
  const queries = [];
  const released = vi.fn();
  const client = {
    query: async (sql) => {
      queries.push(sql);
      if (failWork && sql === 'WORK') throw new Error('work failed');
      return { rows: [] };
    },
    release: released
  };
  return {
    database: { connect: async () => client },
    queries,
    released
  };
}

describe('withTransaction', () => {
  it('commits successful work and always releases the client', async () => {
    const { database, queries, released } = fakeDatabase();
    const result = await withTransaction(database, async (client) => {
      await client.query('WORK');
      return 'done';
    });

    expect(result).toBe('done');
    expect(queries).toEqual(['BEGIN', 'WORK', 'COMMIT']);
    expect(released).toHaveBeenCalledOnce();
  });

  it('rolls back and rethrows when work fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { database, queries, released } = fakeDatabase({ failWork: true });

    try {
      await expect(withTransaction(database, async (client) => {
        await client.query('WORK');
      })).rejects.toThrow('work failed');
      expect(queries).toEqual(['BEGIN', 'WORK', 'ROLLBACK']);
      expect(released).toHaveBeenCalledOnce();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
