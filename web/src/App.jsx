import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, clearCsrfToken, fetchCsrfToken, setCsrfToken } from './api.js';
import AsyncBoundary from './AsyncBoundary.jsx';
import AttachmentsPanel from './AttachmentsPanel.jsx';
import Footer from './Footer.jsx';
import SessionsPanel from './SessionsPanel.jsx';
import useRetryableLazy from './useRetryableLazy.js';
import WorkspaceLayout from './WorkspaceLayout.jsx';
import {
  AUTH_PATHS,
  EMPLOYEE_PATHS,
  navigateTo,
  parseRoute,
  tokenFromSearch,
  useRoute
} from './routing.js';

import {
  DemoBadge,
  ErrorBanner,
  Notice,
  Pagination,
  SlaStatusBadge,
  StatCard,
  StatusBadge,
  ThemeToggle,
  formatDate,
  formatDuration,
  formatTimeRemaining
} from './ui.jsx';

const PAGE_SIZE = 10;
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const STATUSES = ['New', 'Assigned', 'In Progress', 'Pending', 'Resolved', 'Closed'];
const EMPTY_PAGINATION = { page: 1, limit: PAGE_SIZE, total: 0, totalPages: 1 };
const EMPTY_FILTERS = { status: '', priority: '', search: '' };
const SUPPORTED_ROLES = ['employee', 'agent', 'admin'];
const REDIRECT_KEY = 'helpdesk:redirect';

function consumeRedirect(user, fallback) {
  let stored = null;
  try {
    stored = window.sessionStorage.getItem(REDIRECT_KEY);
    window.sessionStorage.removeItem(REDIRECT_KEY);
  } catch {
    stored = null;
  }
  if (!stored) return fallback;
  const area = parseRoute(stored).area;
  const allowed = user.role === 'employee' ? area === 'employee' : area === 'staff';
  return allowed ? stored : fallback;
}

function workspacePath(user) {
  return user?.role === 'employee' ? EMPLOYEE_PATHS.dashboard : '/staff';
}

function LoginForm({ onSubmit, error, notice, onRegister, onReset }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await onSubmit({ email, password });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen auth-with-footer">
      <section className="auth-card">
        <span className="eyebrow">HelpDesk Pro</span>
        <div className="auth-theme-row"><ThemeToggle /></div>
        <h1>Sign in to HelpDesk Pro</h1>
        <p className="muted">Access your tickets, track SLA deadlines and talk to the service desk.</p>
        <ErrorBanner message={error} />
        <Notice message={notice} />
        <form onSubmit={handleSubmit} className="form-stack">
          <label htmlFor="login-email">Work email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            required
          />
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="auth-hint">Employees, agents and administrators sign in here and are routed to their workspace.</p>
        {onReset && (
          <button type="button" className="button button-link auth-toggle" onClick={onReset}>
            Forgot your password?
          </button>
        )}
        {onRegister && (
          <button type="button" className="button button-link auth-toggle" onClick={onRegister}>
            Need an account? Register as an employee
          </button>
        )}
      </section>
      <Footer />
    </main>
  );
}

function RegistrationForm({ onSubmit, onSignIn, error }) {
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmPassword: ''
  });
  const [confirmationError, setConfirmationError] = useState('');
  const [busy, setBusy] = useState(false);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (form.password !== form.confirmPassword) {
      setConfirmationError('Passwords do not match.');
      return;
    }
    setConfirmationError('');
    setBusy(true);
    try {
      await onSubmit({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        password: form.password,
        confirmPassword: form.confirmPassword
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <span className="eyebrow">HelpDesk Pro</span>
        <div className="auth-theme-row"><ThemeToggle /></div>
        <h1>Create your employee account</h1>
        <p className="muted">Register to submit requests and follow their progress.</p>
        <ErrorBanner message={confirmationError || error} />
        <form onSubmit={handleSubmit} className="form-stack">
          <label htmlFor="register-first-name">First name</label>
          <input
            id="register-first-name"
            value={form.firstName}
            onChange={(event) => update('firstName', event.target.value)}
            autoComplete="given-name"
            required
          />
          <label htmlFor="register-last-name">Last name</label>
          <input
            id="register-last-name"
            value={form.lastName}
            onChange={(event) => update('lastName', event.target.value)}
            autoComplete="family-name"
            required
          />
          <label htmlFor="register-email">Work email</label>
          <input
            id="register-email"
            type="email"
            value={form.email}
            onChange={(event) => update('email', event.target.value)}
            autoComplete="username"
            placeholder="you@company.com"
            required
          />
          <label htmlFor="register-password">Password</label>
          <input
            id="register-password"
            type="password"
            value={form.password}
            onChange={(event) => update('password', event.target.value)}
            autoComplete="new-password"
            required
          />
          <label htmlFor="register-confirm-password">Confirm password</label>
          <input
            id="register-confirm-password"
            type="password"
            value={form.confirmPassword}
            onChange={(event) => update('confirmPassword', event.target.value)}
            autoComplete="new-password"
            required
          />
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Creating account…' : 'Create account'}
          </button>
        </form>
        <button type="button" className="button button-link auth-toggle" onClick={onSignIn}>
          Already registered? Sign in
        </button>
      </section>
    </main>
  );
}

function PasswordResetForm({ token: resetToken, onSignIn, onComplete, notice }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (resetToken && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const endpoint = resetToken ? '/auth/password-reset/confirm' : '/auth/password-reset/request';
      const body = resetToken
        ? { token: resetToken, password, confirmPassword }
        : { email };
      await apiRequest(endpoint, { method: 'POST', body });
      if (resetToken) {
        const successMessage = 'Password updated. You can now sign in with your new password.';
        setMessage(successMessage);
        onComplete?.(successMessage);
      } else {
        setMessage('If that address has an account, a reset link is on its way.');
      }
    } catch (caught) {
      setError(caught.message || 'The request could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <span className="eyebrow">HelpDesk Pro</span>
        <div className="auth-theme-row"><ThemeToggle /></div>
        <h1>{resetToken ? 'Choose a new password' : 'Reset your password'}</h1>
        <p className="muted">
          {resetToken
            ? 'Use a strong password you have not used before.'
            : 'We will email a single-use link if the address belongs to an account.'}
        </p>
        <ErrorBanner message={error} />
        <Notice message={message || notice} />
        <form onSubmit={handleSubmit} className="form-stack">
          {!resetToken && (
            <>
              <label htmlFor="reset-email">Work email</label>
              <input
                id="reset-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                required
              />
            </>
          )}
          {resetToken && (
            <>
              <label htmlFor="reset-password">New password</label>
              <input
                id="reset-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
              <label htmlFor="reset-confirm-password">Confirm new password</label>
              <input
                id="reset-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
            </>
          )}
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Submitting…' : resetToken ? 'Update password' : 'Send reset link'}
          </button>
        </form>
        <button type="button" className="button button-link auth-toggle" onClick={onSignIn}>
          Back to sign in
        </button>
      </section>
    </main>
  );
}

function EmailVerificationForm({ token: verificationToken, onSignIn, onComplete }) {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!verificationToken || startedRef.current) return;
    startedRef.current = true;
    apiRequest('/auth/verification/confirm', { method: 'POST', body: { token: verificationToken } })
      .then(() => {
        const successMessage = 'Email verified. You can sign in now.';
        setMessage(successMessage);
        onComplete?.(successMessage);
      })
      .catch((caught) => setError(caught.message || 'This verification link is invalid or expired.'));
  }, [verificationToken]);

  async function resend(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await apiRequest('/auth/verification/resend', { method: 'POST', body: { email } });
      setMessage('If that address needs verification, a new link is on its way.');
    } catch (caught) {
      setError(caught.message || 'The verification email could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <span className="eyebrow">HelpDesk Pro</span>
        <div className="auth-theme-row"><ThemeToggle /></div>
        <h1>Verify your email</h1>
        <p className="muted">
          {verificationToken
            ? 'Checking your verification link…'
            : 'Enter your work email and we will send a fresh verification link.'}
        </p>
        <ErrorBanner message={error} />
        <Notice message={message} />
        {!verificationToken && (
          <form onSubmit={resend} className="form-stack">
            <label htmlFor="verify-email">Work email</label>
            <input
              id="verify-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
            />
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? 'Sending…' : 'Resend verification email'}
            </button>
          </form>
        )}
        <button type="button" className="button button-link auth-toggle" onClick={onSignIn}>
          Go to sign in
        </button>
      </section>
    </main>
  );
}

function TicketList({ tickets, onSelect, busy, filtered }) {
  if (tickets.length === 0) {
    return (
      <p className="empty-state">
        {filtered ? 'No tickets match the current filters.' : 'You have not submitted any tickets yet.'}
      </p>
    );
  }

  return (
    <div className="table-wrap">
      <table className="ticket-table">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Status</th>
            <th>Priority</th>
            <th>Updated</th>
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => (
            <tr key={ticket.id}>
              <td>
                <span className="ticket-code">{ticket.ticketCode}</span>
                <span className="ticket-title">{ticket.title}</span>
                {ticket.isDemo && <DemoBadge />}
                {ticket.isOverdue && <span className="overdue-tag">SLA overdue</span>}
              </td>
              <td><StatusBadge status={ticket.status} /></td>
              <td>{ticket.priority}</td>
              <td>{formatDate(ticket.updatedAt)}</td>
              <td>
                <button
                  type="button"
                  className="button button-link"
                  onClick={() => onSelect(ticket.id)}
                  disabled={busy}
                >
                  View
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewTicketForm({ categories, onSubmit, onCancel, error }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    categoryId: '',
    subcategoryId: '',
    priority: 'Medium'
  });
  const [busy, setBusy] = useState(false);

  const selectedCategory = categories.find((category) => String(category.id) === String(form.categoryId));
  const subcategories = selectedCategory?.subcategories ?? [];

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await onSubmit({
        title: form.title.trim(),
        description: form.description.trim(),
        categoryId: Number(form.categoryId),
        subcategoryId: form.subcategoryId ? Number(form.subcategoryId) : null,
        priority: form.priority
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel form-panel">
      <h1>Submit a ticket</h1>
      <p className="muted">Describe the issue clearly so the service desk can route it correctly.</p>
      <ErrorBanner message={error} />
      <form onSubmit={handleSubmit} className="form-grid">
        <div className="field field-wide">
          <label htmlFor="ticket-title">Short title</label>
          <input
            id="ticket-title"
            value={form.title}
            onChange={(event) => update('title', event.target.value)}
            minLength={3}
            maxLength={200}
            required
          />
        </div>
        <div className="field field-wide">
          <label htmlFor="ticket-description">Description</label>
          <textarea
            id="ticket-description"
            value={form.description}
            onChange={(event) => update('description', event.target.value)}
            minLength={10}
            maxLength={10000}
            rows={5}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="ticket-category">Category</label>
          <select
            id="ticket-category"
            value={form.categoryId}
            onChange={(event) => setForm((current) => ({
              ...current,
              categoryId: event.target.value,
              subcategoryId: ''
            }))}
            required
          >
            <option value="">Choose a category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ticket-subcategory">Subcategory</label>
          <select
            id="ticket-subcategory"
            value={form.subcategoryId}
            onChange={(event) => update('subcategoryId', event.target.value)}
            disabled={subcategories.length === 0}
          >
            <option value="">Not specified</option>
            {subcategories.map((subcategory) => (
              <option key={subcategory.id} value={subcategory.id}>{subcategory.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ticket-priority">Priority</label>
          <select
            id="ticket-priority"
            value={form.priority}
            onChange={(event) => update('priority', event.target.value)}
          >
            {PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}
          </select>
        </div>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Submitting…' : 'Submit ticket'}
          </button>
        </div>
      </form>
    </section>
  );
}

function TicketDetail({
  ticket,
  onComment,
  onClose,
  onEdit,
  onCancel,
  onReopen,
  onBack,
  onApiError,
  currentUser,
  error,
  busy
}) {
  const [comment, setComment] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ title: ticket.title, description: ticket.description });
  const comments = (ticket.comments ?? []).filter((item) => !item.isInternal);
  const history = ticket.history ?? [];
  const isOpen = ticket.status !== 'Resolved' && ticket.status !== 'Closed';

  useEffect(() => {
    setEditing(false);
    setEditForm({ title: ticket.title, description: ticket.description });
  }, [ticket.id, ticket.title, ticket.description]);

  async function handleComment(event) {
    event.preventDefault();
    const trimmed = comment.trim();
    if (!trimmed) return;
    setCommentBusy(true);
    try {
      const saved = await onComment(trimmed);
      if (saved) setComment('');
    } finally {
      setCommentBusy(false);
    }
  }

  function startEditing() {
    setEditForm({ title: ticket.title, description: ticket.description });
    setEditing(true);
  }

  async function handleEdit(event) {
    event.preventDefault();
    const saved = await onEdit({
      title: editForm.title.trim(),
      description: editForm.description.trim()
    });
    if (saved) setEditing(false);
  }

  return (
    <section className="detail-layout">
      <button type="button" className="button button-link back-link" onClick={onBack}>← Back to dashboard</button>
      <div className="detail-header">
        <div>
          <span className="eyebrow">{ticket.ticketCode}</span>
          <h1>{ticket.title}</h1>
          {ticket.isDemo && <DemoBadge />}
        </div>
        <div className="detail-badges">
          <StatusBadge status={ticket.status} />
          {ticket.isOverdue && <span className="overdue-tag">SLA overdue</span>}
        </div>
      </div>

      <ErrorBanner message={error} />

      <div className="detail-grid">
        <div className="detail-main">
          <article className="panel">
            <h2>Description</h2>
            {editing ? (
              <form onSubmit={handleEdit} className="form-grid self-edit-form">
                <div className="field field-wide">
                  <label htmlFor="edit-ticket-title">Edit title</label>
                  <input
                    id="edit-ticket-title"
                    value={editForm.title}
                    onChange={(event) => setEditForm((current) => ({ ...current, title: event.target.value }))}
                    minLength={3}
                    maxLength={200}
                    required
                    disabled={busy}
                  />
                </div>
                <div className="field field-wide">
                  <label htmlFor="edit-ticket-description">Edit description</label>
                  <textarea
                    id="edit-ticket-description"
                    value={editForm.description}
                    onChange={(event) => setEditForm((current) => ({ ...current, description: event.target.value }))}
                    minLength={10}
                    maxLength={10000}
                    rows={5}
                    required
                    disabled={busy}
                  />
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setEditing(false)}
                    disabled={busy}
                  >
                    Discard changes
                  </button>
                  <button type="submit" className="button button-primary" disabled={busy}>
                    {busy ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </form>
            ) : (
              <>
                <p className="preserve-lines">{ticket.description}</p>
                {ticket.resolutionNotes && (
                  <div className="resolution-box">
                    <h3>Resolution</h3>
                    <p>{ticket.resolutionNotes}</p>
                  </div>
                )}
                {isOpen && (
                  <button type="button" className="button button-secondary edit-toggle" onClick={startEditing} disabled={busy}>
                    Edit ticket
                  </button>
                )}
              </>
            )}
          </article>

          <article className="panel">
            <h2>Conversation</h2>
            {comments.length === 0 ? (
              <p className="muted">No public replies yet.</p>
            ) : (
              <ul className="comment-list">
                {comments.map((item) => (
                  <li key={item.id} className="comment">
                    <div className="comment-meta">
                      <strong>{item.authorName}</strong>
                      <time>{formatDate(item.createdAt)}</time>
                    </div>
                    <p>{item.body}</p>
                  </li>
                ))}
              </ul>
            )}
            {ticket.status !== 'Closed' && (
              <form onSubmit={handleComment} className="comment-form">
                <label htmlFor="new-comment">Add a reply</label>
                <textarea
                  id="new-comment"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  minLength={1}
                  maxLength={5000}
                  rows={3}
                  required
                />
                <button type="submit" className="button button-primary" disabled={commentBusy || !comment.trim()}>
                  {commentBusy ? 'Sending…' : 'Send reply'}
                </button>
              </form>
            )}
          </article>

          <AttachmentsPanel
            ticketId={ticket.id}
            ticketStatus={ticket.status}
            currentUserId={currentUser?.id}
            currentUserName={`${currentUser?.firstName ?? ''} ${currentUser?.lastName ?? ''}`.trim()}
            onApiError={onApiError}
          />
        </div>

        <aside className="detail-side">
          <article className="panel">
            <h2>Ticket details</h2>
            <dl className="detail-list">
              <dt>Category</dt><dd>{ticket.categoryName}</dd>
              <dt>Subcategory</dt><dd>{ticket.subcategoryName ?? '—'}</dd>
              <dt>Priority</dt><dd>{ticket.priority}</dd>
              <dt>Assignee</dt><dd>{ticket.assigneeName ?? 'Awaiting assignment'}</dd>
              <dt>Created</dt><dd>{formatDate(ticket.createdAt)}</dd>
              <dt>SLA status</dt>
              <dd>
                <SlaStatusBadge
                  status={ticket.sla?.status}
                  firstRespondedAt={ticket.firstRespondedAt}
                  responseMinutes={ticket.sla?.responseMinutes}
                />
              </dd>
              <dt>Time remaining</dt><dd>{formatTimeRemaining(ticket.sla?.timeRemainingMinutes, ticket.sla?.status)}</dd>
              <dt>Response due</dt><dd>{formatDate(ticket.responseDueAt)}</dd>
              <dt>First response</dt><dd>{formatDate(ticket.firstRespondedAt)}</dd>
              <dt>Response time</dt><dd>{formatDuration(ticket.sla?.responseMinutes)}</dd>
              <dt>Resolution time</dt><dd>{formatDuration(ticket.sla?.resolutionMinutes)}</dd>
            </dl>
            <div className="self-service-actions">
              {ticket.status === 'Resolved' && (
                <button type="button" className="button button-secondary button-block" onClick={onClose} disabled={busy}>
                  Confirm resolution
                </button>
              )}
              {isOpen && (
                <button
                  type="button"
                  className="button button-secondary button-block button-danger"
                  onClick={onCancel}
                  disabled={busy}
                >
                  Cancel ticket
                </button>
              )}
              {(ticket.status === 'Resolved' || ticket.status === 'Closed') && (
                <button
                  type="button"
                  className="button button-secondary button-block"
                  onClick={onReopen}
                  disabled={busy}
                >
                  Reopen ticket
                </button>
              )}
            </div>
          </article>

          <article className="panel">
            <h2>Activity</h2>
            <ol className="timeline">
              {history.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.action.replace(/_/g, ' ')}</strong>
                  <span>{entry.actorName} · {formatDate(entry.createdAt)}</span>
                </li>
              ))}
            </ol>
          </article>
        </aside>
      </div>
    </section>
  );
}

export default function App() {
  const [StaffApp, retryStaffApp] = useRetryableLazy(() => import('./StaffApp.jsx'));
  const { pathname, search, route } = useRoute();
  const [session, setSession] = useState(undefined);
  const [booting, setBooting] = useState(true);
  const [authError, setAuthError] = useState('');
  const [lifecycleNotice, setLifecycleNotice] = useState('');
  const [tickets, setTickets] = useState([]);
  const [summary, setSummary] = useState(null);
  const [categories, setCategories] = useState([]);
  const [pagination, setPagination] = useState(EMPTY_PAGINATION);
  const view = route.area === 'employee' ? route.view : 'dashboard';
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const detailRequestRef = useRef(0);
  const detailRouteRef = useRef(null);
  const portalRequestRef = useRef(0);
  const initialiseRef = useRef(null);
  const sessionEpochRef = useRef(0);
  const explicitSignOutRef = useRef(false);
  const forbiddenHandlerRef = useRef(null);
  const sessionRef = useRef(null);
  sessionRef.current = session;

  const clearPortalData = useCallback(({ preserveAuthError = false } = {}) => {
    detailRequestRef.current += 1;
    portalRequestRef.current += 1;
    setTickets([]);
    setSummary(null);
    setCategories([]);
    setPagination(EMPTY_PAGINATION);
    setSelectedTicket(null);
    setNotice('');
    setActionError('');
    if (!preserveAuthError) setAuthError('');
    setShowSessions(false);
    setDetailBusy(false);
    setDetailLoading(false);
    detailRouteRef.current = null;
    setFilters(EMPTY_FILTERS);
    setLoading(false);
  }, []);

  const endSession = useCallback((options) => {
    sessionEpochRef.current += 1;
    clearCsrfToken();
    clearPortalData(options);
    setSession(null);
  }, [clearPortalData]);

  const handleApiError = useCallback((error) => {
    if (error?.status === 401) {
      setAuthError('Your session expired. Please sign in again.');
      endSession({ preserveAuthError: true });
      return;
    }
    if (error?.status === 403) {
      forbiddenHandlerRef.current?.(error);
      return;
    }
    setActionError(error?.message || 'Something went wrong. Please try again.');
  }, [endSession]);

  const handleForbidden = useCallback(async (error) => {
    const epoch = sessionEpochRef.current;
    const detail = error?.message ? ` (${error.message})` : '';
    setActionError(`Your access changed${detail}. Refreshing your workspace…`);
    try {
      const response = await apiRequest('/auth/me');
      if (epoch !== sessionEpochRef.current) return;
      const user = response.data.user;
      if (!SUPPORTED_ROLES.includes(user.role)) {
        setAuthError('Your account no longer has access to this workspace.');
        endSession({ preserveAuthError: true });
        return;
      }
      const current = sessionRef.current;
      if (current && current.id === user.id && current.role === user.role) {
        setActionError(`Your access changed${detail}. Please refresh or sign in again.`);
        return;
      }
      setSession(user);
    } catch (error) {
      if (epoch === sessionEpochRef.current) handleApiError(error);
    }
  }, [endSession, handleApiError]);

  forbiddenHandlerRef.current = handleForbidden;

  const handleStaffUnauthorized = useCallback(() => {
    handleApiError({ status: 401 });
  }, [handleApiError]);

  const loadPortalData = useCallback(async (overrides = {}) => {
    const requestId = ++portalRequestRef.current;
    const page = overrides.page ?? pagination.page;
    const activeFilters = overrides.filters ?? filters;
    setLoading(true);
    setActionError('');
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_SIZE)
      });
      if (activeFilters.status) params.set('status', activeFilters.status);
      if (activeFilters.priority) params.set('priority', activeFilters.priority);
      if (activeFilters.search.trim()) params.set('search', activeFilters.search.trim());

      const [ticketResult, summaryResult, categoryResult] = await Promise.allSettled([
        apiRequest(`/tickets?${params.toString()}`),
        apiRequest('/tickets/summary'),
        apiRequest('/categories')
      ]);
      if (requestId !== portalRequestRef.current) return;

      const metadataResults = [summaryResult, categoryResult];
      const authFailure = metadataResults.find((result) => (
        result.status === 'rejected' && [401, 403].includes(result.reason?.status)
      ));
      if (authFailure) {
        handleApiError(authFailure.reason);
        return;
      }
      if (ticketResult.status === 'rejected') {
        handleApiError(ticketResult.reason);
        return;
      }

      const ticketList = ticketResult.value;
      const responsePage = Number(ticketList.meta?.page ?? page);
      const totalPages = Math.max(1, Number(ticketList.meta?.totalPages ?? 1));
      setTickets(ticketList.data);
      setPagination({
        page: Math.min(responsePage, totalPages),
        limit: Number(ticketList.meta?.limit ?? PAGE_SIZE),
        total: Number(ticketList.meta?.total ?? ticketList.data.length),
        totalPages
      });
      if (summaryResult.status === 'fulfilled') setSummary(summaryResult.value.data);
      if (categoryResult.status === 'fulfilled') setCategories(categoryResult.value.data);
      if (metadataResults.some((result) => result.status === 'rejected')) {
        setActionError('Your tickets loaded, but some workspace details could not be refreshed.');
      }
    } catch (error) {
      if (requestId === portalRequestRef.current) handleApiError(error);
    } finally {
      if (requestId === portalRequestRef.current) setLoading(false);
    }
  }, [filters, pagination.page, handleApiError]);

  const refreshSelectedTicket = useCallback(async (id) => {
    const requestId = ++detailRequestRef.current;
    try {
      const response = await apiRequest(`/tickets/${id}`);
      if (requestId !== detailRequestRef.current) return false;
      setSelectedTicket(response.data.ticket);
      return true;
    } catch (error) {
      if (requestId === detailRequestRef.current) handleApiError(error);
      return false;
    }
  }, [handleApiError]);

  useEffect(() => {
    if (initialiseRef.current) return;
    initialiseRef.current = (async () => {
      try {
        await fetchCsrfToken();
        const response = await apiRequest('/auth/me');
        const user = response.data.user;
        if (!SUPPORTED_ROLES.includes(user.role)) {
          clearPortalData();
          setSession({ ...user, unsupported: true });
        } else {
          setSession(user);
        }
      } catch (error) {
        if (error?.status !== 401) setAuthError(error.message);
        endSession({ preserveAuthError: error?.status !== 401 });
      } finally {
        setBooting(false);
      }
    })();
  }, [clearPortalData, endSession]);

  useEffect(() => {
    const publicPaths = [
      AUTH_PATHS.login,
      AUTH_PATHS.register,
      AUTH_PATHS.reset,
      AUTH_PATHS.verify,
      AUTH_PATHS.unavailable
    ];
    if (session === null && !publicPaths.includes(pathname)) {
      try {
        if (explicitSignOutRef.current) {
          window.sessionStorage.removeItem(REDIRECT_KEY);
        } else {
          window.sessionStorage.setItem(REDIRECT_KEY, pathname + search);
        }
      } catch {
        // Storage can be disabled; the default workspace remains the fallback.
      }
      explicitSignOutRef.current = false;
      navigateTo(AUTH_PATHS.login, { replace: true });
    }
    if (session?.unsupported && pathname !== AUTH_PATHS.unavailable) {
      navigateTo(AUTH_PATHS.unavailable, { replace: true });
      return;
    }
    if (session && !session.unsupported
      && [AUTH_PATHS.login, AUTH_PATHS.register].includes(pathname)) {
      navigateTo(workspacePath(session), { replace: true });
    }
  }, [session, pathname, search]);

  useEffect(() => {
    if (session?.role !== 'employee' || session.unsupported || route.area !== 'employee') return;
    if (view !== 'detail') {
      detailRouteRef.current = null;
      return;
    }
    const key = String(route.ticketId);
    if (detailRouteRef.current === key && selectedTicket
      && Number(selectedTicket.id) === Number(route.ticketId)) return;
    detailRouteRef.current = key;
    openTicket(route.ticketId);
  }, [session, route.area, route.view, route.ticketId, view]);

  useEffect(() => {
    if (session?.role === 'employee' && !session.unsupported) loadPortalData();
  }, [session, filters, pagination.page, loadPortalData]);

  function changeView(next) {
    detailRequestRef.current += 1;
    setNotice('');
    setActionError('');
    if (next !== 'detail') setSelectedTicket(null);
    navigateTo(EMPLOYEE_PATHS[next] ?? EMPLOYEE_PATHS.dashboard);
  }

  function updateFilter(field, value) {
    setFilters((current) => ({ ...current, [field]: value }));
    setPagination((current) => ({ ...current, page: 1 }));
  }

  async function handleLogin(credentials) {
    explicitSignOutRef.current = false;
    setAuthError('');
    setLifecycleNotice('');
    try {
      const response = await apiRequest('/auth/login', { method: 'POST', body: credentials });
      const user = response.data.user;
      clearPortalData();
      if (!SUPPORTED_ROLES.includes(user.role)) {
        setSession({ ...user, unsupported: true });
        navigateTo(AUTH_PATHS.unavailable);
        return;
      }
      setSession(user);
      navigateTo(consumeRedirect(user, user.role === 'employee'
        ? EMPLOYEE_PATHS.dashboard
        : '/staff'), { replace: true });
    } catch (error) {
      setAuthError(error.message);
    }
  }

  async function handleRegister(registration) {
    explicitSignOutRef.current = false;
    setAuthError('');
    setLifecycleNotice('');
    try {
      const response = await apiRequest('/auth/register', { method: 'POST', body: registration });
      if (response.data?.csrfToken) setCsrfToken(response.data.csrfToken);
      let user = response.data?.user;
      if (!user?.id) {
        const me = await apiRequest('/auth/me');
        user = me.data?.user;
      }
      if (!user?.id) throw new Error('The service returned an unexpected response.');
      if (response.data?.requiresVerification) {
        setAuthError('Check your email for a verification link before signing in.');
        return;
      }
      clearPortalData();
      setSession(user);
      navigateTo(consumeRedirect(user, user.role === 'employee'
        ? EMPLOYEE_PATHS.dashboard
        : '/staff'), { replace: true });
    } catch (error) {
      setAuthError(error.message);
    }
  }

  async function handleLogout() {
    explicitSignOutRef.current = true;
    setLoggingOut(true);
    let logoutFailed = false;
    try {
      await apiRequest('/auth/logout', { method: 'POST', body: {} });
    } catch {
      // Clear local state even if the server cannot be reached, but warn the user.
      logoutFailed = true;
    } finally {
      setLoggingOut(false);
      endSession({ preserveAuthError: logoutFailed });
      if (logoutFailed) {
        setAuthError('Signed out locally, but the server could not be reached. Your session may remain active.');
      }
    }
  }

  function handleLifecycleBack({ revokeSession = false } = {}) {
    setAuthError('');
    if (revokeSession || session === null) {
      endSession();
      navigateTo(AUTH_PATHS.login, { replace: true });
      return;
    }
    navigateTo(workspacePath(session), { replace: true });
  }

  function handleLifecycleComplete(message, { revokeSession = false } = {}) {
    setAuthError('');
    setLifecycleNotice(message);
    if (revokeSession || session === null) {
      endSession();
      navigateTo(AUTH_PATHS.login, { replace: true });
      return;
    }
    navigateTo(workspacePath(session), { replace: true });
  }

  async function openTicket(id) {
    const requestId = ++detailRequestRef.current;
    setActionError('');
    setNotice('');
    setSelectedTicket(null);
    setDetailLoading(true);
    try {
      const response = await apiRequest(`/tickets/${id}`);
      if (requestId !== detailRequestRef.current) return;
      setSelectedTicket(response.data.ticket);
      detailRouteRef.current = String(id);
      navigateTo(EMPLOYEE_PATHS.detail(id));
    } catch (error) {
      if (requestId === detailRequestRef.current) {
        detailRouteRef.current = null;
        handleApiError(error);
        if (route.area === 'employee' && view === 'detail') {
          navigateTo(EMPLOYEE_PATHS.dashboard, { replace: true });
        }
      }
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  }

  async function handleCreate(payload) {
    setActionError('');
    try {
      const response = await apiRequest('/tickets', { method: 'POST', body: payload });
      clearPortalData();
      setNotice('Ticket submitted successfully.');
      await loadPortalData({ page: 1, filters: EMPTY_FILTERS });
      await openTicket(response.data.ticket.id);
    } catch (error) {
      handleApiError(error);
    }
  }

  async function handleComment(body) {
    const trimmed = body.trim();
    if (!trimmed || !selectedTicket) return;
    const id = selectedTicket.id;
    setActionError('');
    try {
      await apiRequest(`/tickets/${id}/comments`, {
        method: 'POST',
        body: { body: trimmed }
      });
      const refreshed = await refreshSelectedTicket(id);
      if (!refreshed) return false;
      setNotice('Reply added.');
      return true;
    } catch (error) {
      handleApiError(error);
      return false;
    }
  }

  async function runDetailAction(request, successMessage) {
    if (!selectedTicket) return false;
    const id = selectedTicket.id;
    setDetailBusy(true);
    setActionError('');
    try {
      await request(id);
      const refreshed = await refreshSelectedTicket(id);
      if (!refreshed) return false;
      setNotice(successMessage);
      await loadPortalData();
      return true;
    } catch (error) {
      handleApiError(error);
      return false;
    } finally {
      setDetailBusy(false);
    }
  }

  function handleEdit({ title, description }) {
    return runDetailAction(
      (id) => apiRequest(`/tickets/${id}`, {
        method: 'PATCH',
        body: { title, description }
      }),
      'Ticket updated.'
    );
  }

  function handleCancel() {
    return runDetailAction(
      (id) => apiRequest(`/tickets/${id}/cancel`, { method: 'POST', body: {} }),
      'Ticket cancelled.'
    );
  }

  function handleReopen() {
    return runDetailAction(
      (id) => apiRequest(`/tickets/${id}/reopen`, { method: 'POST', body: {} }),
      'Ticket reopened.'
    );
  }

  function handleClose() {
    return runDetailAction(
      (id) => apiRequest(`/tickets/${id}/close`, { method: 'POST', body: {} }),
      'Ticket closed. Thank you for confirming the resolution.'
    );
  }

  if (booting || session === undefined) {
    return (
      <main className="auth-screen">
        <div className="loading-card" role="status">Loading your workspace…</div>
        <ThemeToggle />
      </main>
    );
  }

  if (route.view === 'reset') {
    return (
      <PasswordResetForm
        token={tokenFromSearch(search)}
        onSignIn={() => handleLifecycleBack({ revokeSession: Boolean(tokenFromSearch(search)) })}
        onComplete={(message) => handleLifecycleComplete(message, { revokeSession: true })}
        notice={authError}
      />
    );
  }
  if (route.view === 'verify') {
    return (
      <EmailVerificationForm
        token={tokenFromSearch(search)}
        onSignIn={() => handleLifecycleBack()}
        onComplete={(message) => handleLifecycleComplete(message)}
      />
    );
  }

  if (session === null) {
    return route.view === 'register' ? (
      <RegistrationForm
        onSubmit={handleRegister}
        onSignIn={() => { setAuthError(''); navigateTo(AUTH_PATHS.login); }}
        error={authError}
      />
    ) : (
      <LoginForm
        onSubmit={handleLogin}
        onRegister={() => { setAuthError(''); setLifecycleNotice(''); navigateTo(AUTH_PATHS.register); }}
        onReset={() => { setAuthError(''); setLifecycleNotice(''); navigateTo(AUTH_PATHS.reset); }}
        error={authError}
        notice={lifecycleNotice}
      />
    );
  }

  if (session.unsupported) {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <span className="eyebrow">HelpDesk Pro</span>
          <div className="auth-theme-row"><ThemeToggle /></div>
          <h1>Workspace unavailable</h1>
          <p className="muted">
            This workspace is not available for the {session.role} role. Please contact an administrator.
          </p>
          <button type="button" className="button button-primary" onClick={handleLogout} disabled={loggingOut}>
            {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </section>
      </main>
    );
  }

  let workspace;

  if (session.role === 'agent' || session.role === 'admin') {
    workspace = (
      <AsyncBoundary resetKey={session.id} onRetry={retryStaffApp} title="Staff workspace unavailable">
        <Suspense fallback={<main className="auth-screen"><div className="loading-card" role="status">Loading staff workspace…</div></main>}>
          <StaffApp
            key={`${session.id}:${session.role}`}
            user={session}
            onLogout={handleLogout}
            loggingOut={loggingOut}
            onUnauthorized={handleStaffUnauthorized}
            onForbidden={handleForbidden}
          />
        </Suspense>
      </AsyncBoundary>
    );
  } else {
    const hasFilters = Boolean(filters.status || filters.priority || filters.search.trim());

    workspace = (
      <>
        <header className="app-header">
        <div className="brand">
          <span className="brand-mark">HD</span>
          <span>HelpDesk Pro</span>
          <span className="brand-portal">Employee portal</span>
        </div>
        <div className="header-actions">
          <span className="user-label">{session.firstName} {session.lastName}</span>
          <button type="button" className="button button-link" onClick={() => setShowSessions(true)}>
            Sessions
          </button>
          <ThemeToggle />
          <button type="button" className="button button-secondary" onClick={handleLogout} disabled={loggingOut}>
            {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      <main className="app-main">
        <Notice message={notice} />

        {view === 'detail' && (!selectedTicket
          || Number(selectedTicket.id) !== Number(route.ticketId)) ? (
          <section className="panel" aria-label="Ticket detail">
            <p className="muted" role="status">
              {detailLoading ? 'Loading ticket…' : 'Ticket is not available.'}
            </p>
          </section>
        ) : view === 'detail' ? (
          <TicketDetail
            ticket={selectedTicket}
            onComment={handleComment}
            onClose={handleClose}
            onEdit={handleEdit}
            onCancel={handleCancel}
            onReopen={handleReopen}
            onBack={() => changeView('dashboard')}
            onApiError={handleApiError}
            currentUser={session}
            error={actionError}
            busy={detailBusy}
          />
        ) : (
          <>
            <div className="page-heading">
              <div>
                <span className="eyebrow">Your service desk</span>
                <h1>Employee portal</h1>
                <p className="muted">Track requests, reply to the service desk and confirm resolutions.</p>
              </div>
              <button type="button" className="button button-primary" onClick={() => changeView('new')}>
                New ticket
              </button>
            </div>

            {view === 'dashboard' && (
              <ErrorBanner message={actionError} onDismiss={() => setActionError('')} />
            )}

            {view === 'new' ? (
              <NewTicketForm
                categories={categories}
                onSubmit={handleCreate}
                onCancel={() => changeView('dashboard')}
                error={actionError}
              />
            ) : (
              <>
                <section className="stats-grid" aria-label="Ticket summary">
                  <StatCard label="Total tickets" value={summary?.total} />
                  <StatCard label="Open" value={summary?.open} tone="info" />
                  <StatCard label="Overdue SLA" value={summary?.overdue} tone="danger" />
                  <StatCard label="Resolved" value={summary?.resolved} tone="success" />
                  <StatCard label="Closed" value={summary?.closed} />
                </section>

                <section className="panel">
                  <div className="list-heading">
                    <h2>My tickets</h2>
                    <div className="filters">
                      <label className="sr-only" htmlFor="status-filter">Filter by status</label>
                      <select
                        id="status-filter"
                        value={filters.status}
                        onChange={(event) => updateFilter('status', event.target.value)}
                      >
                        <option value="">All statuses</option>
                        {STATUSES.map((status) => <option key={status}>{status}</option>)}
                      </select>
                      <label className="sr-only" htmlFor="priority-filter">Filter by priority</label>
                      <select
                        id="priority-filter"
                        value={filters.priority}
                        onChange={(event) => updateFilter('priority', event.target.value)}
                      >
                        <option value="">All priorities</option>
                        {PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}
                      </select>
                      <label className="sr-only" htmlFor="ticket-search">Search tickets</label>
                      <input
                        id="ticket-search"
                        type="search"
                        placeholder="Search tickets"
                        value={filters.search}
                        onChange={(event) => updateFilter('search', event.target.value)}
                      />
                    </div>
                  </div>
                  {loading ? <p className="muted">Loading tickets…</p> : (
                    <>
                      <TicketList
                        tickets={tickets}
                        onSelect={openTicket}
                        busy={false}
                        filtered={hasFilters}
                      />
                      <Pagination
                        pagination={pagination}
                        onPageChange={(page) => {
                          setNotice('');
                          setActionError('');
                          setPagination((current) => ({ ...current, page }));
                        }}
                      />
                    </>
                  )}
                </section>
              </>
            )}
          </>
        )}
        </main>
      </>
    );
  }

  return (
    <>
      <WorkspaceLayout>{workspace}</WorkspaceLayout>
      {showSessions && (
        <SessionsPanel
          onClose={() => setShowSessions(false)}
          onUnauthorized={handleStaffUnauthorized}
        />
      )}
    </>
  );
}
