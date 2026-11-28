import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { env } from '../config/env.js';
import { badRequest, notFoundError } from '../utils/errors.js';

const ATTACHMENTS_PREFIX = 'helpdesk-pro/attachments';
const QUARANTINE_PREFIX = 'helpdesk-pro/quarantine';

function storedPath(directory, storedName) {
  if (!/^[a-f0-9-]{36}(\.[a-z0-9]+)?$/.test(storedName)) {
    throw badRequest('Invalid stored attachment name');
  }
  return join(resolve(directory), storedName);
}

export function attachmentPath(directory, storedName) {
  return storedPath(directory, storedName);
}

function quarantineSuffix(originalName) {
  return String(originalName ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .trim()
    .split('.')
    .pop()
    .slice(0, 12)
    .replace(/[^a-zA-Z0-9]/g, '');
}

function quarantineName(originalName) {
  const suffix = quarantineSuffix(originalName);
  return `${randomUUID()}${suffix ? `.${suffix}` : ''}.quarantine`;
}

/** Filesystem adapter used by Docker Compose and Render, where directories persist. */
export function createLocalAttachmentStore({
  directory = env.UPLOAD_DIR,
  quarantineDirectory = env.AV_QUARANTINE_DIR
} = {}) {
  const uploadRoot = resolve(directory);
  const quarantineRoot = resolve(quarantineDirectory);

  return {
    async put({ storedName, buffer }) {
      const target = storedPath(uploadRoot, storedName);
      await mkdir(uploadRoot, { recursive: true });
      await writeFile(target, buffer, { flag: 'wx' });
      return { storedName, target };
    },

    async read({ storedName }) {
      const target = storedPath(uploadRoot, storedName);
      await access(target);
      return { stream: createReadStream(target) };
    },

    async remove({ storedName }) {
      await unlink(storedPath(uploadRoot, storedName)).catch(() => {});
    },

    async quarantine({ buffer, originalName }) {
      try {
        await mkdir(quarantineRoot, { recursive: true });
        await writeFile(join(quarantineRoot, quarantineName(originalName)), buffer, { flag: 'wx' });
      } catch (error) {
        console.warn('[attachments] quarantine write failed:', error?.message ?? error);
      }
    }
  };
}

/**
 * Private Vercel Blob adapter. Downloads stay behind the authenticated API
 * route; blob URLs are never returned to clients. The SDK reads
 * BLOB_READ_WRITE_TOKEN from the environment automatically.
 */
export function createBlobAttachmentStore({ loadBlob = () => import('@vercel/blob') } = {}) {
  let blobModule;

  async function getBlob() {
    if (!blobModule) blobModule = await loadBlob();
    return blobModule;
  }

  function blobPath(storedName) {
    storedPath('.', storedName);
    return `${ATTACHMENTS_PREFIX}/${storedName}`;
  }

  return {
    async put({ storedName, buffer, contentType }) {
      const { put } = await getBlob();
      const blob = await put(blobPath(storedName), buffer, {
        access: 'private',
        contentType: contentType ?? 'application/octet-stream',
        addRandomSuffix: false,
        cacheControlMaxAge: 60
      });
      return { storedName, pathname: blob.pathname, url: blob.url };
    },

    async read({ storedName }) {
      const { get } = await getBlob();
      const result = await get(blobPath(storedName), { access: 'private' });
      if (!result || result.statusCode !== 200 || !result.stream) {
        throw notFoundError('Attachment not found');
      }
      return { stream: Readable.fromWeb(result.stream), metadata: result.blob };
    },

    async remove({ storedName }) {
      const { del } = await getBlob();
      await del(blobPath(storedName));
    },

    async quarantine({ buffer, originalName }) {
      try {
        const { put } = await getBlob();
        await put(`${QUARANTINE_PREFIX}/${quarantineName(originalName)}`, buffer, {
          access: 'private',
          contentType: 'application/octet-stream',
          addRandomSuffix: false,
          cacheControlMaxAge: 60
        });
      } catch (error) {
        console.warn('[attachments] quarantine write failed:', error?.message ?? error);
      }
    }
  };
}

export function createAttachmentStore({
  directory = env.UPLOAD_DIR,
  quarantineDirectory = env.AV_QUARANTINE_DIR,
  mode = env.ATTACHMENT_STORAGE
} = {}) {
  return mode === 'blob'
    ? createBlobAttachmentStore()
    : createLocalAttachmentStore({ directory, quarantineDirectory });
}
