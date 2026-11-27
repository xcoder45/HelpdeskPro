import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from './api.js';
import { ErrorBanner, Notice, formatDate } from './ui.jsx';

export default function SessionsPanel({ onClose, onUnauthorized }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const previousFocusRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiRequest('/auth/sessions');
      setSessions(response.data.sessions ?? []);
    } catch (caught) {
      if (caught?.status === 401) onUnauthorized?.();
      else setError(caught.message || 'Sessions could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previousFocusRef.current instanceof HTMLElement) previousFocusRef.current.focus();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  async function revoke(sessionId) {
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/auth/sessions/${sessionId}`, { method: 'DELETE' });
      setNotice('That session has been signed out.');
      await load();
    } catch (caught) {
      if (caught?.status === 401) onUnauthorized?.();
      else setError(caught.message || 'The session could not be revoked.');
    } finally {
      setBusy(false);
    }
  }

  async function revokeOthers() {
    setBusy(true);
    setError('');
    try {
      const response = await apiRequest('/auth/sessions', { method: 'DELETE' });
      setNotice(`${response.data.revoked} other session${response.data.revoked === 1 ? '' : 's'} signed out.`);
      await load();
    } catch (caught) {
      if (caught?.status === 401) onUnauthorized?.();
      else setError(caught.message || 'Other sessions could not be revoked.');
    } finally {
      setBusy(false);
    }
  }

  const isExpired = (session) => Date.parse(session.expiresAt) <= Date.now();
  const otherActiveSessions = sessions.filter((session) => (
    !session.current && !session.revoked && !isExpired(session)
  ));

  return (
    <div className="auth-screen">
      <section ref={dialogRef} className="auth-card sessions-card" role="dialog" aria-modal="true" aria-labelledby="sessions-title">
        <span className="eyebrow">HelpDesk Pro</span>
        <h1 id="sessions-title">Active sessions</h1>
        <p className="muted">Review where this account is signed in and close sessions you do not recognise.</p>
        <ErrorBanner message={error} onDismiss={() => setError('')} />
        <Notice message={notice} />
        {loading ? (
          <p className="muted" role="status">Loading sessions…</p>
        ) : (
          <>
            <ul className="session-list">
              {sessions.map((session) => (
                <li key={session.id}>
                  <strong>{session.current ? 'This device' : session.ipAddress || 'Another device'}</strong>
                  <span className="muted">
                    {session.revoked ? 'Signed out' : isExpired(session) ? 'Expired' : 'Active'} · Signed in {formatDate(session.createdAt)}
                    {session.lastUsedAt ? ` · Last used ${formatDate(session.lastUsedAt)}` : ''}
                    {` · Expires ${formatDate(session.expiresAt)}`}
                    {session.userAgent ? ` · ${session.userAgent}` : ''}
                  </span>
                  {!session.current && !session.revoked && !isExpired(session) && (
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => revoke(session.id)}
                      disabled={busy}
                    >
                      Sign out
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="button button-secondary"
              onClick={revokeOthers}
              disabled={busy || otherActiveSessions.length === 0}
            >
              Sign out of other devices
            </button>
          </>
        )}
        <button ref={closeRef} type="button" className="button button-primary" onClick={onClose}>
          Done
        </button>
      </section>
    </div>
  );
}
