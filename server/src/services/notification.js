import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

const TEMPLATES = {
  'user.registered': {
    subject: () => 'Welcome to HelpDesk Pro',
    body: (context) => `Hello ${context.user.firstName},\n\nYour HelpDesk Pro account is ready. You can now submit and track support tickets.`
  },
  'ticket.created': {
    subject: (context) => `${context.ticket.ticketCode}: ticket received`,
    body: (context) => `Hello ${context.recipient.name},\n\nWe received your ticket "${context.ticket.title}".\nTicket: ${context.ticket.ticketCode}\nPriority: ${context.ticket.priority}\n\nYou can follow its progress in the HelpDesk Pro portal.`
  },
  'ticket.assigned': {
    subject: (context) => `${context.ticket.ticketCode}: ticket assigned to you`,
    body: (context) => `Hello ${context.recipient.name},\n\nThe ticket "${context.ticket.title}" (${context.ticket.ticketCode}) has been assigned to you.\nPriority: ${context.ticket.priority}\n\nPlease review it in the staff workspace.`
  },
  'ticket.agent_replied': {
    subject: (context) => `${context.ticket.ticketCode}: a support agent replied`,
    body: (context) => `Hello ${context.recipient.name},\n\nA support agent replied to your ticket "${context.ticket.title}" (${context.ticket.ticketCode}).\n\nSign in to the employee portal to read the public reply.`
  },
  'ticket.employee_replied': {
    subject: (context) => `${context.ticket.ticketCode}: the requester replied`,
    body: (context) => `Hello ${context.recipient.name},\n\nThe requester added a reply to ticket "${context.ticket.title}" (${context.ticket.ticketCode}).\n\nPlease review it in the staff workspace.`
  },
  'ticket.status_changed': {
    subject: (context) => `${context.ticket.ticketCode}: status changed to ${context.ticket.status}`,
    body: (context) => `Hello ${context.recipient.name},\n\nYour ticket "${context.ticket.title}" (${context.ticket.ticketCode}) is now ${context.ticket.status}.`
  },
  'ticket.resolved': {
    subject: (context) => `${context.ticket.ticketCode}: ticket resolved`,
    body: (context) => `Hello ${context.recipient.name},\n\nYour ticket "${context.ticket.title}" (${context.ticket.ticketCode}) has been resolved.\n\nSign in to the employee portal to review the resolution.`
  },
  'ticket.closed': {
    subject: (context) => `${context.ticket.ticketCode}: ticket closed`,
    body: (context) => `Hello ${context.recipient.name},\n\nYour ticket "${context.ticket.title}" (${context.ticket.ticketCode}) is now closed.`
  },
  'ticket.cancelled': {
    subject: (context) => `${context.ticket.ticketCode}: ticket cancelled`,
    body: (context) => `Hello ${context.recipient.name},\n\nYour ticket "${context.ticket.title}" (${context.ticket.ticketCode}) has been cancelled as requested.`
  },
  'ticket.reopened': {
    subject: (context) => `${context.ticket.ticketCode}: ticket reopened`,
    body: (context) => `Hello ${context.recipient.name},\n\nYour ticket "${context.ticket.title}" (${context.ticket.ticketCode}) has been reopened and is now ${context.ticket.status}.`
  },
  'auth.password_reset': {
    subject: () => 'Reset your HelpDesk Pro password',
    body: (context) => `Hello ${context.recipient.name},\n\nUse this link to reset your HelpDesk Pro password:\n${env.APP_BASE_URL.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(context.token)}\n\nThe link expires soon and can be used once. If you did not request it, you can ignore this message.`
  },
  'auth.email_verification': {
    subject: () => 'Verify your HelpDesk Pro email address',
    body: (context) => `Hello ${context.recipient.name},\n\nVerify your email address with this link:\n${env.APP_BASE_URL.replace(/\/$/, '')}/verify-email?token=${encodeURIComponent(context.token)}\n\nThe link expires soon and can be used once.`
  }
};

function defaultTransporter() {
  if (!env.SMTP_HOST || !env.SMTP_FROM) return null;
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER
      ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' }
      : undefined
  });
}

export function createNotificationService({
  transporter = defaultTransporter(),
  enabled = env.NOTIFICATIONS_ENABLED,
  from = env.SMTP_FROM,
  logger = console
} = {}) {
  return {
    async send(event, context = {}) {
      if (!enabled) return { sent: false, reason: 'disabled' };

      const template = TEMPLATES[event];
      if (!template) return { sent: false, reason: 'unknown_event' };
      if (!transporter || !from) {
        logger.info?.('[notifications] delivery skipped', { event, reason: 'not_configured' });
        return { sent: false, reason: 'not_configured' };
      }

      const recipients = (context.recipients ?? []).filter(
        (recipient, index, all) => recipient?.email
          && all.findIndex((other) => other.email.toLowerCase() === recipient.email.toLowerCase()) === index
      );
      if (recipients.length === 0) return { sent: false, reason: 'no_recipients' };

      try {
        const results = await Promise.allSettled(recipients.map((recipient) => transporter.sendMail({
          from,
          to: recipient.email,
          subject: template.subject(context),
          text: template.body({ ...context, recipient })
        })));

        const sent = [];
        const failed = [];
        results.forEach((result, index) => {
          const emailAddress = recipients[index].email;
          if (result.status === 'fulfilled') {
            sent.push(emailAddress);
          } else {
            failed.push({
              email: emailAddress,
              message: result.reason?.message ?? 'unknown error'
            });
          }
        });

        if (failed.length > 0) {
          logger.warn?.('[notifications] one or more deliveries failed', {
            event,
            ticketCode: context.ticket?.ticketCode ?? null,
            failed: failed.map((item) => item.email),
            message: failed[0].message
          });
        }

        if (sent.length === 0) return { sent: false, reason: 'delivery_failed' };
        return {
          sent: true,
          recipients: sent,
          ...(failed.length > 0 ? { failedRecipients: failed.map((item) => item.email) } : {})
        };
      } catch (error) {
        logger.warn?.('[notifications] delivery failed', {
          event,
          ticketCode: context.ticket?.ticketCode ?? null,
          message: error?.message ?? 'unknown error'
        });
        return { sent: false, reason: 'delivery_failed' };
      }
    }
  };
}

export const notificationService = createNotificationService();
