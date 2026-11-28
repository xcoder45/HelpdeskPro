import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { sendSuccess } from './utils/apiResponse.js';
import { errorHandler, notFound } from './middleware/error.js';
import { csrfProtection } from './middleware/csrf.js';
import { createRequireAuth } from './middleware/auth.js';
import { createAuthRouter } from './modules/auth/routes.js';
import { createUsersRouter } from './modules/users/routes.js';
import { createTicketsRouter } from './modules/tickets/routes.js';
import { createCategoriesRouter } from './modules/catalog/routes.js';
import { createSlaRouter } from './modules/sla/routes.js';
import { createAnalyticsRouter } from './modules/analytics/routes.js';
import { createAuditRouter } from './modules/audit/routes.js';
import { createAttachmentDownloadRouter } from './modules/attachments/routes.js';
import { createCronRouter } from './modules/cron/routes.js';
import { ticketWriteRateLimiter } from './middleware/rateLimit.js';
import { notificationService } from './services/notification.js';

const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

export function createApp({
  database = pool,
  writeRateLimiter = ticketWriteRateLimiter,
  notifier = notificationService,
  uploadDirectory,
  attachmentScanner,
  attachmentStore,
  cronSecret,
  retentionRunner,
  staticDirectory = webDist,
  serveStatic = env.NODE_ENV === 'production'
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  if (env.TRUST_PROXY_HOPS !== undefined) {
    app.set('trust proxy', env.TRUST_PROXY_HOPS);
  }
  app.use(env.NODE_ENV === 'production' ? helmet() : helmet({ contentSecurityPolicy: false }));
  app.use((req, res, next) => {
    if (req.originalUrl.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    return next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(csrfProtection);

  app.get('/api/health', async (_req, res, next) => {
    try {
      await database.query('SELECT 1');
      return sendSuccess(res, { status: 'ok', database: 'ok' });
    } catch (error) {
      return next(error);
    }
  });

  app.use('/api/cron', createCronRouter({
    database,
    ...(cronSecret !== undefined ? { secret: cronSecret } : {}),
    ...(retentionRunner !== undefined ? { runner: retentionRunner } : {})
  }));

  const requireAuth = createRequireAuth(database);
  app.use('/api/auth', createAuthRouter({ database, requireAuth, notifier }));
  app.use('/api/users', requireAuth, createUsersRouter({ database }));
  app.use('/api/categories', requireAuth, createCategoriesRouter({ database }));
  app.use('/api/tickets', requireAuth, createTicketsRouter({
    database,
    writeRateLimiter,
    notifier,
    ...(uploadDirectory !== undefined ? { uploadDirectory } : {}),
    ...(attachmentScanner !== undefined ? { attachmentScanner } : {}),
    ...(attachmentStore !== undefined ? { attachmentStore } : {})
  }));
  app.use('/api/sla', requireAuth, createSlaRouter({ database, writeRateLimiter }));
  app.use('/api/dashboard', requireAuth, createAnalyticsRouter({ database }));
  app.use('/api/audit-logs', requireAuth, createAuditRouter({ database }));
  app.use('/api/attachments', requireAuth, createAttachmentDownloadRouter({
    database,
    ...(uploadDirectory !== undefined ? { directory: uploadDirectory } : {}),
    ...(attachmentStore !== undefined ? { store: attachmentStore } : {})
  }));

  app.use('/api', notFound);

  if (serveStatic && existsSync(resolve(staticDirectory, 'index.html'))) {
    const resolvedStaticDirectory = resolve(staticDirectory);
    app.use(express.static(resolvedStaticDirectory, { index: false }));
    app.use((req, res, next) => {
      if (!['GET', 'HEAD'].includes(req.method) || req.path.startsWith('/api/')) return next();
      return res.sendFile(resolve(resolvedStaticDirectory, 'index.html'));
    });
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
