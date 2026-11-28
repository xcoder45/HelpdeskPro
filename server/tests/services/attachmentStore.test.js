import { describe, expect, it, vi } from 'vitest';
import { createBlobAttachmentStore } from '../../src/services/attachmentStore.js';

function createBlobMock(overrides = {}) {
  const mocks = {
    put: vi.fn(async () => ({ pathname: 'helpdesk-pro/attachments/file.pdf', url: 'https://blob.example/file.pdf' })),
    get: vi.fn(async () => ({ statusCode: 200, stream: new Blob(['attachment bytes']).stream() })),
    del: vi.fn(async () => {})
  };
  const blob = { ...mocks, ...overrides };
  return { blob, mocks, loadBlob: vi.fn(async () => blob) };
}

describe('private Vercel Blob attachment store', () => {
  it('uploads private blobs without random suffixes and never returns URLs to callers', async () => {
    const { mocks, loadBlob } = createBlobMock();
    const store = createBlobAttachmentStore({ loadBlob });

    const result = await store.put({
      storedName: '550e8400-e29b-41d4-a716-446655440000.pdf',
      buffer: Buffer.from('%PDF-1.7'),
      contentType: 'application/pdf'
    });

    expect(loadBlob).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenCalledWith(
      'helpdesk-pro/attachments/550e8400-e29b-41d4-a716-446655440000.pdf',
      Buffer.from('%PDF-1.7'),
      expect.objectContaining({
        access: 'private',
        contentType: 'application/pdf',
        addRandomSuffix: false
      })
    );
    expect(result.storedName).toBe('550e8400-e29b-41d4-a716-446655440000.pdf');
  });

  it('reads private blobs as a Node stream', async () => {
    const { loadBlob } = createBlobMock();
    const store = createBlobAttachmentStore({ loadBlob });
    const result = await store.read({ storedName: '550e8400-e29b-41d4-a716-446655440000.pdf' });
    const chunks = [];

    for await (const chunk of result.stream) chunks.push(chunk);

    expect(Buffer.concat(chunks).toString()).toBe('attachment bytes');
    expect(loadBlob).toHaveBeenCalledTimes(1);
  });

  it('reports a missing blob as a not-found attachment', async () => {
    const { loadBlob } = createBlobMock({
      get: vi.fn(async () => ({ statusCode: 404 }))
    });
    const store = createBlobAttachmentStore({ loadBlob });

    await expect(store.read({ storedName: '550e8400-e29b-41d4-a716-446655440000.pdf' }))
      .rejects
      .toThrow(/attachment not found/i);
  });

  it('deletes by deterministic pathname and rejects path traversal', async () => {
    const { mocks, loadBlob } = createBlobMock();
    const store = createBlobAttachmentStore({ loadBlob });

    await store.remove({ storedName: '550e8400-e29b-41d4-a716-446655440000.pdf' });
    expect(mocks.del).toHaveBeenCalledWith('helpdesk-pro/attachments/550e8400-e29b-41d4-a716-446655440000.pdf');

    await expect(store.remove({ storedName: '../../secret.pdf' }))
      .rejects
      .toThrow(/invalid stored attachment name/i);
  });

  it('quarantines rejected files as private blobs and treats write failure as non-fatal', async () => {
    const { mocks, loadBlob } = createBlobMock();
    const store = createBlobAttachmentStore({ loadBlob });

    await store.quarantine({ buffer: Buffer.from('infected'), originalName: 'unsafe/../virus.txt' });
    expect(mocks.put).toHaveBeenCalledWith(
      expect.stringMatching(/^helpdesk-pro\/quarantine\/.*\.txt\.quarantine$/),
      Buffer.from('infected'),
      expect.objectContaining({ access: 'private' })
    );

    const failing = createBlobAttachmentStore({
      loadBlob: async () => ({
        put: vi.fn(async () => {
          throw new Error('blob unavailable');
        })
      })
    });
    await expect(failing.quarantine({ buffer: Buffer.from('x'), originalName: 'x.txt' }))
      .resolves
      .toBeUndefined();
  });
});
