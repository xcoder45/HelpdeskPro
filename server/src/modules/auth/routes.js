import { Router } from 'express';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { createRequireAuth } from '../../middleware/auth.js';
import { authRateLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { notificationService } from '../../services/notification.js';
import { sendSuccess } from '../../utils/apiResponse.js';
import {
  clearAccessTokenCookie,
  clearCsrfCookie,
  generateCsrfToken,
  setAccessTokenCookie,
  setCsrfCookie
} from '../../utils/cookies.js';
import { findUserByEmail } from '../users/service.js';
import {
  createAuthToken,
  listSessions,
  resetPasswordWithClient,
  revokeOtherSessions,
  revokeSession,
  verifyEmailWithClient
} from './lifecycle.js';
import { authenticate, registerEmployee } from './service.js';
import {
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  registerSchema,
  sessionIdSchema,
  verificationConfirmSchema,
  verificationRequestSchema
} from './schemas.js';

function requestMeta(req) {
  return {
    ipAddress: req.ip,
    userAgent: req.get('user-agent') ?? null
  };
}

async function notifySafely(notifier, event, context) {
  try {
    await notifier?.send(event, context);
  } catch (error) {
    console.warn('[notifications] event skipped', event, error?.message ?? error);
  }
}

function fullName(user) {
  return `${user.firstName} ${user.lastName}`.trim();
}

export function createAuthRouter({
  database = pool,
  requireAuth = createRequireAuth(database),
  notifier = notificationService
} = {}) {
  const router = Router();

  router.get('/csrf', (req, res) => {
    return sendSuccess(res, { csrfToken: req.cookies.csrf_token });
  });

  router.post('/register', authRateLimiter, validate(registerSchema), async (req, res) => {
    const result = await withTransaction(database, async (client) => {
      const registered = await registerEmployee(client, req.body, requestMeta(req));
      await recordAudit(client, {
        actorId: registered.user.id,
        action: 'auth.register',
        entityType: 'user',
        entityId: registered.user.id,
        details: { role: registered.user.role },
        ipAddress: req.ip
      });
      return registered;
    });

    const recipients = [{ email: result.user.email, name: fullName(result.user) }];
    if (!result.requiresVerification) {
      await notifySafely(notifier, 'user.registered', { recipients, user: result.user });
    }
    await notifySafely(notifier, 'auth.email_verification', {
      recipients,
      user: result.user,
      token: result.verificationToken
    });

    const csrfToken = generateCsrfToken();
    setCsrfCookie(res, csrfToken);
    if (result.token) setAccessTokenCookie(res, result.token);
    return sendSuccess(res, {
      user: result.user,
      csrfToken,
      requiresVerification: result.requiresVerification
    }, 201);
  });

  router.post('/login', authRateLimiter, validate(loginSchema), async (req, res) => {
    let result;
    try {
      result = await authenticate(database, req.body, requestMeta(req));
    } catch (error) {
      await recordAudit(database, {
        action: 'auth.login_failed',
        entityType: 'user',
        details: { email: req.body.email },
        ipAddress: req.ip
      });
      throw error;
    }

    await recordAudit(database, {
      actorId: result.user.id,
      action: 'auth.login_success',
      entityType: 'user',
      entityId: result.user.id,
      details: { role: result.user.role },
      ipAddress: req.ip
    });

    const csrfToken = generateCsrfToken();
    setAccessTokenCookie(res, result.token);
    setCsrfCookie(res, csrfToken);
    return sendSuccess(res, { user: result.user, csrfToken });
  });

  router.post('/logout', requireAuth, async (req, res, next) => {
    try {
      await withTransaction(database, async (client) => {
        if (req.auth?.tokenPayload?.jti) {
          await client.query(
            `UPDATE user_sessions SET revoked_at = now()
             WHERE jti = $1 AND user_id = $2 AND revoked_at IS NULL`,
            [req.auth.tokenPayload.jti, req.user.id]
          );
        }
        await recordAudit(client, {
          actorId: req.user.id,
          action: 'auth.logout',
          entityType: 'user',
          entityId: req.user.id,
          details: {},
          ipAddress: req.ip
        });
      });
      clearAccessTokenCookie(res);
      clearCsrfCookie(res);
      return sendSuccess(res, { loggedOut: true });
    } catch (error) {
      return next(error);
    }
  });

  router.post(
    '/password-reset/request',
    authRateLimiter,
    validate(passwordResetRequestSchema),
    async (req, res) => {
      const userRow = await findUserByEmail(database, req.body.email);
      if (userRow?.is_active) {
        const token = await withTransaction(database, async (client) => {
          const issued = await createAuthToken(client, {
            userId: userRow.id,
            purpose: 'password_reset',
            ttl: env.PASSWORD_RESET_TTL
          });
          await recordAudit(client, {
            action: 'auth.password_reset_requested',
            entityType: 'user',
            entityId: userRow.id,
            details: {},
            ipAddress: req.ip
          });
          return issued;
        });
        await notifySafely(notifier, 'auth.password_reset', {
          recipients: [{
            email: userRow.email,
            name: `${userRow.first_name} ${userRow.last_name}`.trim()
          }],
          token
        });
      }
      return sendSuccess(res, { accepted: true });
    }
  );

  router.post(
    '/password-reset/confirm',
    authRateLimiter,
    validate(passwordResetConfirmSchema),
    async (req, res) => {
      await withTransaction(database, async (client) => {
        const result = await resetPasswordWithClient(client, {
          token: req.body.token,
          password: req.body.password,
          ipAddress: req.ip
        });
        await recordAudit(client, {
          actorId: result.userId,
          action: 'auth.password_reset_completed',
          entityType: 'user',
          entityId: result.userId,
          details: {},
          ipAddress: req.ip
        });
      });
      return sendSuccess(res, { reset: true });
    }
  );

  router.post(
    '/verification/resend',
    authRateLimiter,
    validate(verificationRequestSchema),
    async (req, res) => {
      const userRow = await findUserByEmail(database, req.body.email);
      if (userRow?.is_active && !userRow.email_verified_at) {
        const token = await withTransaction(database, async (client) => {
          const issued = await createAuthToken(client, {
            userId: userRow.id,
            purpose: 'email_verification',
            ttl: env.EMAIL_VERIFICATION_TTL,
            email: userRow.email
          });
          await recordAudit(client, {
            action: 'auth.email_verification_resent',
            entityType: 'user',
            entityId: userRow.id,
            details: {},
            ipAddress: req.ip
          });
          return issued;
        });
        await notifySafely(notifier, 'auth.email_verification', {
          recipients: [{
            email: userRow.email,
            name: `${userRow.first_name} ${userRow.last_name}`.trim()
          }],
          token
        });
      }
      return sendSuccess(res, { accepted: true });
    }
  );

  router.post(
    '/verification/confirm',
    authRateLimiter,
    validate(verificationConfirmSchema),
    async (req, res) => {
      await withTransaction(database, async (client) => {
        const result = await verifyEmailWithClient(client, { token: req.body.token, ipAddress: req.ip });
        await recordAudit(client, {
          actorId: result.userId,
          action: 'auth.email_verified',
          entityType: 'user',
          entityId: result.userId,
          details: {},
          ipAddress: req.ip
        });
      });
      return sendSuccess(res, { verified: true });
    }
  );

  router.get('/sessions', requireAuth, async (req, res) => {
    const sessions = await listSessions(database, req.user.id, req.auth.tokenPayload.jti);
    return sendSuccess(res, { sessions });
  });

  router.delete('/sessions/:sessionId', requireAuth, validate(sessionIdSchema, 'params'), async (req, res) => {
    await withTransaction(database, async (client) => {
      await revokeSession(client, req.user.id, req.validatedParams.sessionId);
      await recordAudit(client, {
        actorId: req.user.id,
        action: 'auth.session_revoked',
        entityType: 'user',
        entityId: req.user.id,
        details: { sessionId: req.validatedParams.sessionId },
        ...requestMeta(req)
      });
    });
    return sendSuccess(res, { revoked: true });
  });

  router.delete('/sessions', requireAuth, async (req, res) => {
    let revoked = 0;
    await withTransaction(database, async (client) => {
      revoked = await revokeOtherSessions(
        client,
        req.user.id,
        req.auth.tokenPayload.jti
      );
      await recordAudit(client, {
        actorId: req.user.id,
        action: 'auth.sessions_revoked',
        entityType: 'user',
        entityId: req.user.id,
        details: { revoked },
        ...requestMeta(req)
      });
    });
    return sendSuccess(res, { revoked });
  });

  router.get('/me', requireAuth, (req, res) => {
    return sendSuccess(res, { user: req.user });
  });

  return router;
}
