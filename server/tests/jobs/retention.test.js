import { describe, expect, it, vi } from 'vitest';
import { runRetention } from '../../src/jobs/retention.js';

describe('retention job', () => {
  it('calls the purge function with configured day counts', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ result: { auditLogsDeleted: 2, ticketHistoryDeleted: 3 } }]
    });
    const result = await runRetention({ query }, { auditDays: 7, historyDays: 30 });

    expect(query).toHaveBeenCalledWith(
      'SELECT purge_expired_activity($1, $2) AS result',
      [7, 30]
    );
    expect(result).toEqual({ auditLogsDeleted: 2, ticketHistoryDeleted: 3 });
  });

  it('removes expired lifecycle records after purging activity', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ result: {} }] });

    await runRetention({ query }, { auditDays: 7, historyDays: 30 });

    expect(query).toHaveBeenCalledWith('DELETE FROM user_sessions WHERE expires_at <= now()');
    expect(query).toHaveBeenCalledWith('DELETE FROM auth_tokens WHERE expires_at <= now()');
  });
});
