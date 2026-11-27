import net from 'node:net';
import { env } from '../config/env.js';
import { unprocessable } from '../utils/errors.js';

function instreamPayload(buffer) {
  const chunks = [Buffer.from('zINSTREAM\0', 'ascii')];
  for (let offset = 0; offset < buffer.length; offset += 4096) {
    const slice = buffer.subarray(offset, Math.min(offset + 4096, buffer.length));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(slice.length, 0);
    chunks.push(length, slice);
  }
  const terminator = Buffer.alloc(4);
  terminator.writeUInt32BE(0, 0);
  chunks.push(terminator);
  return Buffer.concat(chunks);
}

/**
 * Streams a buffer to clamd over INSTREAM. Scanning failures fail closed so an
 * unavailable scanner cannot silently turn into an accepted upload.
 */
export async function scanBuffer(
  buffer,
  {
    host = env.CLAMAV_HOST,
    port = env.CLAMAV_PORT,
    timeoutMs = env.AV_SCAN_TIMEOUT_MS
  } = {}
) {
  if (!env.AV_ENABLED) return { enabled: false, clean: true };
  if (!host) throw unprocessable('Virus scanning is enabled but CLAMAV_HOST is not configured');

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let response = '';
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(value);
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(instreamPayload(buffer)));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (/stream:\s/.test(response)) {
        if (/FOUND/i.test(response)) {
          finish(reject, unprocessable('The file was rejected by the virus scanner'));
        } else if (/OK/i.test(response)) {
          finish(resolve, { enabled: true, clean: true });
        }
      }
    });
    socket.on('timeout', () => finish(reject, unprocessable('Virus scan timed out')));
    socket.on('error', () => finish(reject, unprocessable('Virus scanner is unavailable')));
    socket.on('close', () => {
      if (!settled) finish(reject, unprocessable('Virus scanner returned no verdict'));
    });
    socket.connect(port, host);
  });
}
