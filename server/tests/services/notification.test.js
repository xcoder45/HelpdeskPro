import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotificationService } from '../../src/services/notification.js';

function fakeTransporter() {
  return { sendMail: vi.fn().mockResolvedValue({ messageId: 'test' }) };
}

describe('notification service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends one templated message per unique recipient', async () => {
    const transporter = fakeTransporter();
    const notifier = createNotificationService({
      transporter,
      enabled: true,
      from: 'helpdesk@example.com',
      logger: { warn: vi.fn() }
    });

    const result = await notifier.send('ticket.resolved', {
      ticket: { ticketCode: 'HD-000123', title: 'Printer offline', status: 'Resolved', priority: 'High' },
      recipients: [
        { email: 'User@Example.com', name: 'User One' },
        { email: 'user@example.com', name: 'User One' },
        { email: 'agent@example.com', name: 'Agent One' }
      ]
    });

    expect(result).toMatchObject({ sent: true, recipients: ['User@Example.com', 'agent@example.com'] });
    expect(transporter.sendMail).toHaveBeenCalledTimes(2);
    expect(transporter.sendMail.mock.calls[0][0]).toMatchObject({
      from: 'helpdesk@example.com',
      to: 'User@Example.com'
    });
    expect(transporter.sendMail.mock.calls[0][0].text).toContain('HD-000123');
  });

  it('does not include internal note bodies in notification templates', async () => {
    const transporter = fakeTransporter();
    const notifier = createNotificationService({
      transporter,
      enabled: true,
      from: 'helpdesk@example.com',
      logger: { warn: vi.fn() }
    });

    await notifier.send('ticket.agent_replied', {
      ticket: { ticketCode: 'HD-000124', title: 'VPN issue', status: 'Assigned', priority: 'High' },
      recipients: [{ email: 'user@example.com', name: 'User' }],
      body: 'Internal-only diagnosis must never be emailed'
    });

    expect(JSON.stringify(transporter.sendMail.mock.calls[0][0])).not.toContain('Internal-only diagnosis');
  });

  it('skips delivery cleanly when disabled or unconfigured', async () => {
    const transporter = fakeTransporter();
    const disabled = createNotificationService({ transporter, enabled: false });
    expect(await disabled.send('ticket.created', { recipients: [{ email: 'u@example.com' }] }))
      .toEqual({ sent: false, reason: 'disabled' });

    const logger = { info: vi.fn(), warn: vi.fn() };
    const unconfigured = createNotificationService({ transporter: null, enabled: true, from: null, logger });
    expect(await unconfigured.send('ticket.created', { recipients: [{ email: 'u@example.com' }] }))
      .toEqual({ sent: false, reason: 'not_configured' });
    expect(logger.info).toHaveBeenCalledWith('[notifications] delivery skipped', {
      event: 'ticket.created',
      reason: 'not_configured'
    });
    expect(transporter.sendMail).not.toHaveBeenCalled();
  });

  it('reports delivery failures without throwing', async () => {
    const logger = { warn: vi.fn() };
    const transporter = {
      sendMail: vi.fn().mockRejectedValue(new Error('SMTP unavailable'))
    };
    const notifier = createNotificationService({
      transporter,
      enabled: true,
      from: 'helpdesk@example.com',
      logger
    });

    const result = await notifier.send('ticket.created', {
      recipients: [{ email: 'u@example.com', name: 'User' }],
      ticket: { ticketCode: 'HD-000125' }
    });
    expect(result).toEqual({ sent: false, reason: 'delivery_failed' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('reports partial delivery without losing successful recipients', async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const transporter = {
      sendMail: vi.fn()
        .mockResolvedValueOnce({ messageId: 'ok' })
        .mockRejectedValueOnce(new Error('mailbox unavailable'))
    };
    const notifier = createNotificationService({
      transporter,
      enabled: true,
      from: 'helpdesk@example.com',
      logger
    });

    const result = await notifier.send('ticket.assigned', {
      ticket: { ticketCode: 'HD-000126', title: 'Router issue', status: 'Assigned', priority: 'High' },
      recipients: [
        { email: 'ok@example.com', name: 'Ok User' },
        { email: 'bad@example.com', name: 'Bad User' }
      ]
    });

    expect(result).toEqual({
      sent: true,
      recipients: ['ok@example.com'],
      failedRecipients: ['bad@example.com']
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[notifications] one or more deliveries failed',
      expect.objectContaining({ failed: ['bad@example.com'] })
    );
  });
});
