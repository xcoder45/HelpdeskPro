import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, downloadRequest, uploadRequest } from './api.js';
import { ErrorBanner, Notice, Pagination, formatDate } from './ui.jsx';

export function formatAttachmentSize(sizeBytes) {
  const size = Number(sizeBytes);
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const PAGE_SIZE = 10;
const EMPTY_PAGINATION = { page: 1, limit: PAGE_SIZE, total: 0, totalPages: 1 };

function isVisible(attachment, includeInternal) {
  return includeInternal || attachment?.isInternal !== true;
}

function isOwnUpload(attachment, currentUserId, currentUserName) {
  if (attachment.uploaderId !== undefined && attachment.uploaderId !== null && currentUserId != null) {
    return String(attachment.uploaderId) === String(currentUserId);
  }
  const name = String(currentUserName ?? '').trim();
  return Boolean(name && String(attachment.uploaderName ?? '').trim() === name);
}

export default function AttachmentsPanel({
  ticketId,
  ticketStatus = null,
  canDeleteAny = false,
  includeInternal = false,
  currentUserId = null,
  currentUserName = '',
  onApiError
}) {
  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [file, setFile] = useState(null);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState(EMPTY_PAGINATION);
  const fileInputRef = useRef(null);
  const requestRef = useRef(0);
  const isClosed = String(ticketStatus ?? '').toLowerCase() === 'closed';

  const reportError = useCallback((caught) => {
    if ([401, 403].includes(caught?.status) && onApiError) {
      onApiError(caught);
      return;
    }
    setError(caught?.message || 'Something went wrong. Please try again.');
  }, [onApiError]);

  const loadAttachments = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      const response = await apiRequest(`/tickets/${ticketId}/attachments?${params.toString()}`);
      if (requestId !== requestRef.current) return;
      const list = Array.isArray(response.data) ? response.data : [];
      const responsePage = Number(response.meta?.page ?? page);
      const totalPages = Math.max(1, Number(response.meta?.totalPages ?? 1));
      const nextPage = Math.min(responsePage, totalPages);
      setPagination({
        page: nextPage,
        limit: Number(response.meta?.limit ?? PAGE_SIZE),
        total: Number(response.meta?.total ?? list.length),
        totalPages
      });
      if (nextPage !== page) setPage(nextPage);
      setAttachments(list.filter((attachment) => isVisible(attachment, includeInternal)));
    } catch (caught) {
      if (requestId === requestRef.current) reportError(caught);
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [ticketId, includeInternal, page, reportError]);

  useEffect(() => {
    loadAttachments();
  }, [loadAttachments]);

  async function handleUpload(event) {
    event.preventDefault();
    if (!file || busy || isClosed) return;
    if (!file.size) {
      setError('Choose a non-empty file to upload.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('Files must be 5 MiB or smaller.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    const formData = new FormData();
    formData.append('file', file);
    try {
      await uploadRequest(`/tickets/${ticketId}/attachments`, formData);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setFile(null);
      setNotice('Attachment uploaded.');
      await loadAttachments();
    } catch (caught) {
      reportError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload(attachment) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { blob, filename } = await downloadRequest(
        `/tickets/${ticketId}/attachments/${attachment.id}/download`,
        attachment.originalName
      );
      const resolvedName = filename || attachment.originalName || 'download';
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('This browser cannot download attachments.');
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = resolvedName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNotice(`Downloading ${resolvedName}.`);
    } catch (caught) {
      reportError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(attachment) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiRequest(`/tickets/${ticketId}/attachments/${attachment.id}`, { method: 'DELETE' });
      setNotice('Attachment removed.');
      await loadAttachments();
    } catch (caught) {
      reportError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel attachments-panel">
      <h2>Attachments</h2>
      <ErrorBanner message={error} onDismiss={() => setError('')} />
      <Notice message={notice} />

      {loading ? (
        <p className="muted">Loading attachments…</p>
      ) : attachments.length === 0 ? (
        <p className="muted">No attachments yet.</p>
      ) : (
        <ul className="attachment-list">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="attachment-item">
              <div className="attachment-info">
                <strong>{attachment.originalName}</strong>
                <span>
                  {formatAttachmentSize(attachment.sizeBytes)} · {attachment.uploaderName || 'Unknown'} ·{' '}
                  {formatDate(attachment.createdAt)}
                </span>
              </div>
              <div className="attachment-actions">
                <button
                  type="button"
                  className="button button-link"
                  aria-label={`Download ${attachment.originalName}`}
                  onClick={() => handleDownload(attachment)}
                  disabled={busy}
                >
                  Download
                </button>
                {(canDeleteAny || isOwnUpload(attachment, currentUserId, currentUserName)) && (
                  <button
                    type="button"
                    className="button button-link button-danger"
                    aria-label={`Delete ${attachment.originalName}`}
                    onClick={() => handleDelete(attachment)}
                    disabled={busy || isClosed}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Pagination
        pagination={pagination}
        onPageChange={setPage}
        ariaLabel="Attachment pages"
        itemLabel="attachments"
      />

      <form onSubmit={handleUpload} className="attachment-upload">
        <label htmlFor={`attachment-file-${ticketId}`}>Add an attachment</label>
        <div className="attachment-upload-row">
          <input
            id={`attachment-file-${ticketId}`}
            ref={fileInputRef}
            type="file"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            disabled={busy || isClosed}
          />
          <button type="submit" className="button button-secondary" disabled={busy || !file || isClosed}>
            {busy ? 'Working…' : 'Upload'}
          </button>
        </div>
      </form>
    </article>
  );
}
