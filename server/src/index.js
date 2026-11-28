import { createApp } from './app.js';
import { createAttachmentStore } from './services/attachmentStore.js';

/**
 * Vercel Services entrypoint. Vercel invokes the exported Express app directly,
 * so this module must not listen on a port or start interval timers.
 *
 * Render and Docker continue to use src/server.js, which owns initialization,
 * app.listen(), retention scheduling, and graceful shutdown.
 */
const app = createApp({
  serveStatic: false,
  attachmentStore: createAttachmentStore()
});

export default app;
