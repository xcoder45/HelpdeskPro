import { useEffect, useState } from 'react';

export function DemoBadge() {
  return <span className="demo-tag" title="Seeded demonstration data">Demo</span>;
}

export function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function numericMinutes(value) {
  if (value === null || value === undefined || value === '') return null;
  const minutes = Number(value);
  return Number.isFinite(minutes) ? minutes : null;
}

export function formatDuration(value) {
  const minutes = numericMinutes(value);
  if (minutes === null) return '—';
  return `${minutes} min`;
}

export function formatTimeRemaining(value, status) {
  const minutes = numericMinutes(value);
  if (minutes === null) return '—';
  if (minutes < 0) return `${Math.abs(minutes)} min overdue`;
  if (status === 'breached' && minutes === 0) return '<1 min overdue';
  if (minutes === 0) return 'Due now';
  return `${minutes} min left`;
}

const SLA_STATUS_LABELS = {
  met: 'Met',
  breached: 'Breached',
  pending: 'Pending',
  unverified: 'Unverified'
};

export function resolveSlaStatus(status, { firstRespondedAt, responseMinutes } = {}) {
  if (status !== 'met') return status ?? null;
  const hasEvidence = Boolean(firstRespondedAt)
    && responseMinutes !== null
    && responseMinutes !== undefined
    && responseMinutes !== '';
  return hasEvidence ? 'met' : 'unverified';
}

export function SlaStatusBadge({ status, firstRespondedAt, responseMinutes }) {
  const resolved = resolveSlaStatus(status, { firstRespondedAt, responseMinutes });
  const styleStatus = SLA_STATUS_LABELS[resolved] ? resolved : 'unknown';
  const label = SLA_STATUS_LABELS[styleStatus] ?? 'Unknown';
  return <span className={`sla-status sla-status-${styleStatus}`}>{label}</span>;
}

const TICKET_STATUS_LABELS = {
  New: 'New',
  Assigned: 'Assigned',
  'In Progress': 'In Progress',
  Pending: 'Pending',
  Resolved: 'Resolved',
  Closed: 'Closed'
};

export function StatusBadge({ status }) {
  const requested = status == null || status === '' ? '' : String(status);
  const known = Object.keys(TICKET_STATUS_LABELS).find(
    (label) => label.toLowerCase() === requested.toLowerCase()
  );
  const styleStatus = known ?? 'unknown';
  const slug = known ? known.toLowerCase().replace(/\s+/g, '-') : 'unknown';
  return <span className={`badge badge-${slug}`}>{TICKET_STATUS_LABELS[known] ?? 'unknown'}</span>;
}

export function ErrorBanner({ message, onDismiss }) {
  if (!message) return null;
  return (
    <div className="banner banner-error" role="alert">
      <span>{message}</span>
      {onDismiss && (
        <button type="button" className="banner-close" onClick={onDismiss} aria-label="Dismiss error">
          ×
        </button>
      )}
    </div>
  );
}

export function Notice({ message }) {
  if (!message) return null;
  return <div className="banner banner-success" role="status">{message}</div>;
}

const THEME_STORAGE_KEY = 'helpdesk-theme';

function initialTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState(initialTheme);
  const nextTheme = theme === 'light' ? 'dark' : 'light';

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage may be unavailable in private browsing; the in-memory theme still works.
    }
  }, [theme]);

  return (
    <button
      type="button"
      className="button button-secondary theme-toggle"
      onClick={() => setTheme(nextTheme)}
      aria-label={`Switch to ${nextTheme} mode`}
    >
      {nextTheme === 'dark' ? 'Dark' : 'Light'} mode
    </button>
  );
}

export function StatCard({ label, value, tone = 'default' }) {
  return (
    <article className={`stat-card stat-${tone}`}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">
        {value === null || value === undefined || value === '' ? '—' : value}
      </strong>
    </article>
  );
}

export function Pagination({ pagination, onPageChange, ariaLabel = 'Ticket pages', itemLabel = 'tickets' }) {
  if (pagination.total === 0) return null;
  return (
    <div className="pagination" role="navigation" aria-label={ariaLabel}>
      <span>Page {pagination.page} of {pagination.totalPages} · {pagination.total} {itemLabel}</span>
      <div className="pagination-actions">
        <button
          type="button"
          className="button button-secondary"
          onClick={() => onPageChange(pagination.page - 1)}
          disabled={pagination.page <= 1}
        >
          Previous
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => onPageChange(pagination.page + 1)}
          disabled={pagination.page >= pagination.totalPages}
        >
          Next
        </button>
      </div>
    </div>
  );
}
