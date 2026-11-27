import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from './api.js';
import { STAFF_PATHS, navigateTo, useRoute } from './routing.js';

import AsyncBoundary from './AsyncBoundary.jsx';
import AuditPanel from './AuditPanel.jsx';
import AttachmentsPanel from './AttachmentsPanel.jsx';
import CategoriesPanel from './CategoriesPanel.jsx';
import SessionsPanel from './SessionsPanel.jsx';
import useRetryableLazy from './useRetryableLazy.js';
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
const STATUS_TRANSITIONS = {
  New: ['Assigned', 'In Progress', 'Pending', 'Resolved'],
  Assigned: ['In Progress', 'Pending', 'Resolved'],
  'In Progress': ['Assigned', 'Pending', 'Resolved'],
  Pending: ['In Progress', 'Resolved'],
  Resolved: ['Closed', 'In Progress', 'Assigned'],
  Closed: []
};
const EMPTY_PAGINATION = { page: 1, limit: PAGE_SIZE, total: 0, totalPages: 1 };

const EMPTY_ACTION_FORM = {
  assigneeId: '',
  status: 'New',
  resolutionNotes: '',
  priority: 'Medium',
  comment: '',
  isInternal: false
};

const EMPTY_USER_FORM = {
  firstName: '',
  lastName: '',
  email: '',
  password: '',
  role: 'agent'
};

function formFromTicket(ticket) {
  return {
    assigneeId: ticket.assigneeId ? String(ticket.assigneeId) : '',
    status: ticket.status,
    resolutionNotes: ticket.resolutionNotes ?? '',
    priority: ticket.priority,
    comment: '',
    isInternal: false
  };
}

function allowedStatuses(status) {
  return STATUS_TRANSITIONS[status] ?? [];
}

function StaffTicketList({ tickets, onSelect, filtered }) {
  if (tickets.length === 0) {
    return (
      <p className="empty-state">
        {filtered ? 'No tickets match the current filters.' : 'There are no tickets in the queue.'}
      </p>
    );
  }

  return (
    <div className="table-wrap">
      <table className="ticket-table staff-ticket-table">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Requester</th>
            <th>Status</th>
            <th>Priority</th>
            <th>Assignee</th>
            <th>Response due</th>
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
              <td>{ticket.requesterName ?? '—'}</td>
              <td><StatusBadge status={ticket.status} /></td>
              <td>{ticket.priority}</td>
              <td>{ticket.assigneeName ?? <span className="muted">Unassigned</span>}</td>
              <td>{formatDate(ticket.responseDueAt)}</td>
              <td>
                <button type="button" className="button button-link" onClick={() => onSelect(ticket.id)}>
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

function StaffTicketDetail({
  ticket,
  form,
  onFormChange,
  onBack,
  onAssign,
  onStatus,
  onPriority,
  onComment,
  onApiError,
  currentUser,
  busy
}) {
  const canChange = ticket.status !== 'Closed';
  const nextStatuses = allowedStatuses(ticket.status);
  const assigneeUnchanged = form.assigneeId === (ticket.assigneeId ? String(ticket.assigneeId) : '');
  const priorityUnchanged = form.priority === ticket.priority;
  const comments = ticket.comments ?? [];
  const history = ticket.history ?? [];

  return (
    <section className="detail-layout">
      <button type="button" className="button button-link back-link" onClick={onBack}>
        ← Back to queue
      </button>

      <div className="detail-header">
        <div>
          <span className="eyebrow">{ticket.ticketCode}</span>
          <h1>{ticket.title}</h1>
          {ticket.isDemo && <DemoBadge />}
          <p className="muted">Submitted by {ticket.requesterName ?? 'unknown'} · {formatDate(ticket.createdAt)}</p>
        </div>
        <div className="detail-badges">
          <StatusBadge status={ticket.status} />
          {ticket.isOverdue && <span className="overdue-tag">SLA overdue</span>}
        </div>
      </div>

      <div className="detail-grid">
        <div className="detail-main">
          <article className="panel">
            <h2>Description</h2>
            <p className="preserve-lines">{ticket.description}</p>
            {ticket.resolutionNotes && (
              <div className="resolution-box">
                <h3>Resolution</h3>
                <p>{ticket.resolutionNotes}</p>
              </div>
            )}
          </article>

          <article className="panel">
            <h2>Conversation</h2>
            {comments.length === 0 ? (
              <p className="muted">No replies or notes yet.</p>
            ) : (
              <ul className="comment-list">
                {comments.map((item) => (
                  <li
                    key={item.id}
                    className={`comment${item.isInternal ? ' comment-internal' : ''}`}
                  >
                    <div className="comment-meta">
                      <strong>{item.authorName}</strong>
                      {item.isInternal && <span className="internal-tag">Internal note</span>}
                      <time>{formatDate(item.createdAt)}</time>
                    </div>
                    <p>{item.body}</p>
                  </li>
                ))}
              </ul>
            )}
            {canChange && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  onComment();
                }}
                className="comment-form"
              >
                <label htmlFor="staff-reply">Reply</label>
                <textarea
                  id="staff-reply"
                  value={form.comment}
                  onChange={(event) => onFormChange('comment', event.target.value)}
                  minLength={1}
                  maxLength={5000}
                  rows={3}
                  required
                />
                <label className="checkbox-label" htmlFor="internal-note">
                  <input
                    id="internal-note"
                    type="checkbox"
                    checked={form.isInternal}
                    onChange={(event) => onFormChange('isInternal', event.target.checked)}
                  />
                  Internal note (not visible to the employee)
                </label>
                <button type="submit" className="button button-primary" disabled={busy || !form.comment.trim()}>
                  {busy ? 'Sending…' : 'Send reply'}
                </button>
              </form>
            )}
          </article>

          <AttachmentsPanel
            ticketId={ticket.id}
            ticketStatus={ticket.status}
            canDeleteAny
            includeInternal
            currentUserId={currentUser?.id}
            currentUserName={`${currentUser?.firstName ?? ''} ${currentUser?.lastName ?? ''}`.trim()}
            onApiError={onApiError}
          />
        </div>

        <aside className="detail-side">
          <article className="panel">
            <h2>Triage</h2>
            <div className="form-stack">
              <label htmlFor="staff-assignee">Assignee</label>
              <select
                id="staff-assignee"
                value={form.assigneeId}
                onChange={(event) => onFormChange('assigneeId', event.target.value)}
                disabled={!canChange}
              >
                <option value="">Unassigned</option>
                {assigneeOptions(ticket, form.assigneeId).map((assignee) => (
                  <option key={assignee.id} value={assignee.id}>{assignee.name}</option>
                ))}
              </select>
              <button
                type="button"
                className="button button-secondary"
                onClick={onAssign}
                disabled={busy || !canChange || assigneeUnchanged}
              >
                {busy ? 'Assigning…' : 'Assign'}
              </button>

              <label htmlFor="staff-status">Status</label>
              <select
                id="staff-status"
                value={form.status}
                onChange={(event) => onFormChange('status', event.target.value)}
                disabled={!canChange}
              >
                <option value={ticket.status} disabled>{ticket.status} (current)</option>
                {nextStatuses.map((status) => <option key={status}>{status}</option>)}
              </select>
              {form.status === 'Resolved' && (
                <>
                  <label htmlFor="staff-resolution">Resolution notes</label>
                  <textarea
                    id="staff-resolution"
                    value={form.resolutionNotes}
                    onChange={(event) => onFormChange('resolutionNotes', event.target.value)}
                    minLength={3}
                    maxLength={5000}
                    rows={3}
                    required
                  />
                </>
              )}
              <button
                type="button"
                className="button button-secondary"
                onClick={onStatus}
                disabled={busy || !canChange || !nextStatuses.includes(form.status)}
              >
                {busy ? 'Updating…' : 'Update status'}
              </button>

              <label htmlFor="staff-priority">Priority</label>
              <select
                id="staff-priority"
                value={form.priority}
                onChange={(event) => onFormChange('priority', event.target.value)}
                disabled={!canChange}
              >
                {PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}
              </select>
              <button
                type="button"
                className="button button-secondary"
                onClick={onPriority}
                disabled={busy || !canChange || priorityUnchanged}
              >
                {busy ? 'Updating…' : 'Update priority'}
              </button>
            </div>
          </article>

          <article className="panel">
            <h2>SLA</h2>
            <dl className="detail-list">
              <dt>Status</dt>
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
              <dt>Resolved</dt><dd>{formatDate(ticket.resolvedAt)}</dd>
              <dt>Resolution time</dt><dd>{formatDuration(ticket.sla?.resolutionMinutes)}</dd>
              <dt>Closed</dt><dd>{formatDate(ticket.closedAt)}</dd>
            </dl>
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

function assigneeOptions(ticket, selectedId) {
  const options = [...(ticket.assigneeOptions ?? [])];
  if (ticket.assigneeId && !options.some((item) => String(item.id) === String(ticket.assigneeId))) {
    options.push({ id: ticket.assigneeId, name: ticket.assigneeName ?? 'Current assignee' });
  }
  if (selectedId && !options.some((item) => String(item.id) === String(selectedId))) {
    options.push({ id: selectedId, name: 'Selected agent' });
  }
  return options;
}

function UsersPanel({
  users,
  pagination,
  form,
  filters,
  editingUser,
  currentUserId,
  onChangeForm,
  onChangeFilter,
  onCreate,
  onEdit,
  onSaveEdit,
  onCancelEdit,
  onToggle,
  onRoleChange,
  onPageChange,
  busy,
  loading
}) {
  return (
    <section className="staff-users">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Administration</span>
          <h1>User management</h1>
          <p className="muted">Create accounts and manage roles and access for your team.</p>
        </div>
      </div>

      <div className="staff-users-grid">
        <article className="panel">
          <h2>{editingUser ? 'Edit user' : 'Create user'}</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (editingUser) onSaveEdit();
              else onCreate();
            }}
            className="form-stack"
          >
            <label htmlFor="new-user-first">First name</label>
            <input id="new-user-first" value={form.firstName} onChange={(event) => onChangeForm('firstName', event.target.value)} required />
            <label htmlFor="new-user-last">Last name</label>
            <input id="new-user-last" value={form.lastName} onChange={(event) => onChangeForm('lastName', event.target.value)} required />
            <label htmlFor="new-user-email">Email</label>
            <input id="new-user-email" type="email" value={form.email} onChange={(event) => onChangeForm('email', event.target.value)} required />
            {!editingUser && (
              <>
                <label htmlFor="new-user-password">Password</label>
                <input id="new-user-password" type="password" value={form.password} onChange={(event) => onChangeForm('password', event.target.value)} minLength={10} required />
              </>
            )}
            <label htmlFor="new-user-role">Role</label>
            <select id="new-user-role" value={form.role} onChange={(event) => onChangeForm('role', event.target.value)}>
              <option value="employee">Employee</option>
              <option value="agent">Agent</option>
              <option value="admin">Admin</option>
            </select>
            <div className="inline-actions">
              <button type="submit" className="button button-primary" disabled={busy}>
                {editingUser ? 'Save user' : 'Create user'}
              </button>
              {editingUser && (
                <button type="button" className="button button-secondary" onClick={onCancelEdit} disabled={busy}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        </article>

        <article className="panel">
          <div className="list-heading">
            <h2>Accounts</h2>
            <div className="filters">
              <label className="sr-only" htmlFor="user-search">Search users</label>
              <input
                id="user-search"
                value={filters.search}
                onChange={(event) => onChangeFilter('search', event.target.value)}
                placeholder="Name or email"
              />
              <label className="sr-only" htmlFor="user-role-filter">Filter by role</label>
              <select id="user-role-filter" value={filters.role} onChange={(event) => onChangeFilter('role', event.target.value)}>
                <option value="">All roles</option>
                <option value="employee">Employee</option>
                <option value="agent">Agent</option>
                <option value="admin">Admin</option>
              </select>
              <label className="sr-only" htmlFor="user-status-filter">Filter by status</label>
              <select id="user-status-filter" value={filters.isActive} onChange={(event) => onChangeFilter('isActive', event.target.value)}>
                <option value="">All statuses</option>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </div>
          </div>
          {loading ? (
            <p className="muted">Loading users…</p>
          ) : (
            <>
              <div className="table-wrap">
                <table className="ticket-table">
                  <thead>
                    <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr>
                  </thead>
                  <tbody>
                    {users.map((item) => (
                      <tr key={item.id}>
                        <td>{item.firstName} {item.lastName}{item.isDemo && <DemoBadge />}</td>
                        <td>{item.email}</td>
                        <td>
                          <select
                            aria-label={`Role for ${item.email}`}
                            value={item.role}
                            onChange={(event) => onRoleChange(item, event.target.value)}
                            disabled={busy || item.id === currentUserId}
                          >
                            <option value="employee">Employee</option>
                            <option value="agent">Agent</option>
                            <option value="admin">Admin</option>
                          </select>
                        </td>
                        <td>{item.isActive ? 'Active' : 'Disabled'}</td>
                        <td>
                          <div className="inline-actions">
                            <button
                              type="button"
                              className="button button-link"
                              onClick={() => onEdit(item)}
                              disabled={busy}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="button button-link"
                              onClick={() => onToggle(item)}
                              disabled={busy || item.id === currentUserId}
                            >
                              {item.isActive ? 'Disable' : 'Enable'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {users.length === 0 && <p className="empty-state">No users found.</p>}
              <Pagination
                pagination={pagination}
                ariaLabel="User pages"
                itemLabel="users"
                onPageChange={onPageChange}
              />
            </>
          )}
        </article>
      </div>
    </section>
  );
}

function SlaPanel({
  rules,
  report,
  isAdmin,
  filters,
  pagination,
  loading,
  busy,
  onChangeFilter,
  onPageChange,
  onSaveRule
}) {
  const [drafts, setDrafts] = useState({});

  useEffect(() => {
    setDrafts((current) => {
      const next = { ...current };
      for (const rule of rules) {
        const saved = {
          responseMinutes: rule.responseMinutes,
          isActive: Boolean(rule.isActive)
        };
        const existing = current[rule.id];
        const isDirty = existing
          && (Number(existing.responseMinutes) !== Number(saved.responseMinutes)
            || Boolean(existing.isActive) !== saved.isActive);
        if (!existing || !isDirty) next[rule.id] = saved;
      }
      return next;
    });
  }, [rules]);

  const summary = report?.summary ?? {};
  const rows = Array.isArray(report?.tickets) ? report.tickets : [];
  const hasResponses = Number(summary.responded ?? 0) > 0;
  const compliance = Number(summary.complianceRate);
  const averageResponse = Number(summary.averageResponseMinutes);

  function updateDraft(id, field, value) {
    setDrafts((current) => ({
      ...current,
      [id]: { ...(current[id] ?? {}), [field]: value }
    }));
  }

  function isValidDraft(draft) {
    const minutes = Number(draft?.responseMinutes);
    return Number.isInteger(minutes) && minutes >= 1 && minutes <= 10_080;
  }

  function isOnlyActiveRule(rule) {
    return Boolean(rule.isActive)
      && rules.filter((item) => item.priority === rule.priority && item.isActive).length <= 1;
  }

  return (
    <section className="sla-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Service levels</span>
          <h1>SLA management</h1>
          <p className="muted">Monitor first-response performance and tune response targets.</p>
        </div>
      </div>

      {isAdmin && (
        <article className="panel sla-rules">
          <h2>Response rules</h2>
          <p className="muted">Priority names are fixed. Each priority keeps one active rule; only the response target can be changed.</p>
          <div className="table-wrap">
            <table className="ticket-table sla-rules-table">
              <thead>
                <tr>
                  <th>Priority</th>
                  <th>Response minutes</th>
                  <th>Active</th>
                  <th>Updated</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => {
                  const draft = drafts[rule.id] ?? {
                    responseMinutes: rule.responseMinutes,
                    isActive: Boolean(rule.isActive)
                  };
                  const unchanged = Number(draft.responseMinutes) === Number(rule.responseMinutes)
                    && Boolean(draft.isActive) === Boolean(rule.isActive);
                  return (
                    <tr key={rule.id}>
                      <td>{rule.priority}</td>
                      <td>
                        <input
                          type="number"
                          min={1}
                          aria-label={`Response minutes for ${rule.priority}`}
                          value={draft.responseMinutes}
                          onChange={(event) => updateDraft(rule.id, 'responseMinutes', event.target.value)}
                          disabled={busy}
                        />
                      </td>
                      <td>
                        <label className="checkbox-label" htmlFor={`sla-active-${rule.id}`}>
                          <input
                            id={`sla-active-${rule.id}`}
                            type="checkbox"
                            checked={Boolean(draft.isActive)}
                            onChange={(event) => updateDraft(rule.id, 'isActive', event.target.checked)}
                            disabled={busy || isOnlyActiveRule(rule)}
                            aria-describedby={isOnlyActiveRule(rule)
                              ? `sla-active-hint-${rule.id}`
                              : undefined}
                            title={isOnlyActiveRule(rule)
                              ? 'Each priority must keep at least one active SLA rule'
                              : undefined}
                          />
                          Active
                        </label>
                        {isOnlyActiveRule(rule) && (
                          <span id={`sla-active-hint-${rule.id}`} className="sla-active-hint">
                            Required — last active rule
                          </span>
                        )}
                      </td>
                      <td>{formatDate(rule.updatedAt)}</td>
                      <td>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => onSaveRule(rule.id, draft)}
                          disabled={busy || unchanged || !isValidDraft(draft)}
                        >
                          Save rule
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rules.length === 0 && !loading && <p className="empty-state">No response rules configured.</p>}
        </article>
      )}

      <article className="panel sla-report">
        <h2>Response report</h2>
        <div className="filters sla-filters">
          <label className="sr-only" htmlFor="sla-status">Filter by SLA status</label>
          <select
            id="sla-status"
            value={filters.slaStatus}
            onChange={(event) => onChangeFilter('slaStatus', event.target.value)}
            disabled={busy}
          >
            <option value="">All SLA statuses</option>
            <option value="pending">Pending</option>
            <option value="breached">Breached</option>
            <option value="met">Met</option>
            <option value="unverified">Unverified</option>
          </select>
          <label className="sr-only" htmlFor="sla-priority">Filter by priority</label>
          <select
            id="sla-priority"
            value={filters.priority}
            onChange={(event) => onChangeFilter('priority', event.target.value)}
            disabled={busy}
          >
            <option value="">All priorities</option>
            {PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}
          </select>
          <label className="sr-only" htmlFor="sla-from">Created from</label>
          <input
            id="sla-from"
            type="date"
            value={filters.from}
            onChange={(event) => onChangeFilter('from', event.target.value)}
            disabled={busy}
          />
          <label className="sr-only" htmlFor="sla-to">Created to</label>
          <input
            id="sla-to"
            type="date"
            value={filters.to}
            onChange={(event) => onChangeFilter('to', event.target.value)}
            disabled={busy}
          />
        </div>

        {loading ? (
          <p className="muted">Loading SLA report…</p>
        ) : !report ? (
          <p className="empty-state">SLA report is unavailable.</p>
        ) : (
          <>
            <div className="stats-grid sla-summary" aria-label="SLA summary">
              <StatCard label="Total tickets" value={summary.totalTickets} />
              <StatCard label="Responded" value={summary.responded} tone="info" />
              <StatCard label="Met response" value={summary.metResponse} tone="success" />
              <StatCard label="Breached" value={summary.breached} tone="danger" />
              <StatCard label="Pending response" value={summary.pendingResponse} />
              <StatCard label="Unverified response" value={summary.unverifiedResponse} />
              <StatCard
                label="Compliance rate"
                value={hasResponses && Number.isFinite(compliance) ? `${Number(compliance.toFixed(1))}%` : '—'}
                tone="success"
              />
              <StatCard
                label="Avg. response"
                value={hasResponses && Number.isFinite(averageResponse) ? `${Number(averageResponse.toFixed(1))} min` : '—'}
              />
            </div>

            <div className="table-wrap">
              <table className="ticket-table sla-report-table">
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th>Requester</th>
                    <th>Assignee</th>
                    <th>Response due</th>
                    <th>Time remaining</th>
                    <th>First response</th>
                    <th>Response time</th>
                    <th>SLA result</th>
                    <th>Resolution time</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={row.ticketCode ?? row.id ?? index}>
                      <td>
                        <span className="ticket-code">{row.ticketCode}</span>
                        <span className="ticket-title">{row.title}</span>
                        {row.isDemo && <DemoBadge />}
                        {row.isOverdue && <span className="overdue-tag">SLA overdue</span>}
                      </td>
                      <td>{row.priority}</td>
                      <td><StatusBadge status={row.status} /></td>
                      <td>{row.requesterName ?? '—'}</td>
                      <td>{row.assigneeName ?? <span className="muted">Unassigned</span>}</td>
                      <td>{formatDate(row.responseDueAt)}</td>
                      <td>{formatTimeRemaining(row.timeRemainingMinutes, row.slaStatus)}</td>
                      <td>{formatDate(row.firstRespondedAt)}</td>
                      <td>{formatDuration(row.responseMinutes)}</td>
                      <td>
                        <SlaStatusBadge
                          status={row.slaStatus}
                          firstRespondedAt={row.firstRespondedAt}
                          responseMinutes={row.responseMinutes}
                        />
                      </td>
                      <td>{formatDuration(row.resolutionMinutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length === 0 && <p className="empty-state">No tickets match these SLA filters.</p>}
            <Pagination
              pagination={pagination}
              ariaLabel="SLA report pages"
              itemLabel="tickets"
              onPageChange={onPageChange}
            />
          </>
        )}
      </article>
    </section>
  );
}

export default function StaffApp({ user, onLogout, loggingOut, onUnauthorized, onForbidden }) {
  const [AnalyticsPanel, retryAnalytics, analyticsAttempt] = useRetryableLazy(() => import('./AnalyticsPanel.jsx'));
  const { route } = useRoute();
  const requestedView = route.area === 'staff' ? route.view : 'queue';
  const adminViews = ['analytics', 'users', 'categories', 'audit'];
  const view = adminViews.includes(requestedView) && user.role !== 'admin'
    ? 'queue'
    : requestedView;
  const [tickets, setTickets] = useState([]);
  const [summary, setSummary] = useState(null);
  const [assignees, setAssignees] = useState([]);
  const [pagination, setPagination] = useState(EMPTY_PAGINATION);
  const [filters, setFilters] = useState({ status: '', priority: '', assigneeId: '', search: '' });
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [form, setForm] = useState(EMPTY_ACTION_FORM);
  const formRef = useRef(form);
  formRef.current = form;
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const detailRequestRef = useRef(0);
  const detailRouteRef = useRef(null);
  const queueRequestRef = useRef(0);

  const [users, setUsers] = useState([]);
  const [userPagination, setUserPagination] = useState(EMPTY_PAGINATION);
  const [userFilters, setUserFilters] = useState({ search: '', role: '', isActive: '' });
  const [userForm, setUserForm] = useState(EMPTY_USER_FORM);
  const [editingUser, setEditingUser] = useState(null);
  const [usersLoading, setUsersLoading] = useState(false);
  const usersRequestRef = useRef(0);

  const [auditLogs, setAuditLogs] = useState([]);
  const [auditPagination, setAuditPagination] = useState(EMPTY_PAGINATION);
  const [auditFilters, setAuditFilters] = useState({ action: '', entityType: '', from: '', to: '' });
  const [auditLoading, setAuditLoading] = useState(false);
  const auditRequestRef = useRef(0);

  const [categories, setCategories] = useState([]);
  const [categoryPagination, setCategoryPagination] = useState(EMPTY_PAGINATION);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const categoriesRequestRef = useRef(0);

  const [slaRules, setSlaRules] = useState([]);
  const [slaReport, setSlaReport] = useState(null);
  const [slaFilters, setSlaFilters] = useState({ slaStatus: '', priority: '', from: '', to: '' });
  const [slaPagination, setSlaPagination] = useState(EMPTY_PAGINATION);
  const [slaLoading, setSlaLoading] = useState(false);
  const [slaBusy, setSlaBusy] = useState(false);
  const slaRequestRef = useRef(0);

  const [analytics, setAnalytics] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState('');
  const [analyticsWeeks, setAnalyticsWeeks] = useState(8);
  const analyticsRequestRef = useRef(0);

  const forbiddenHandoffRef = useRef(false);

  const handleApiError = useCallback((caught) => {
    if (caught?.status === 401) {
      onUnauthorized();
      return;
    }
    if (caught?.status === 403 && onForbidden) {
      if (forbiddenHandoffRef.current) return;
      forbiddenHandoffRef.current = true;
      const detail = caught?.message ? ` (${caught.message})` : '';
      const refreshing = `Your access changed${detail}. Refreshing your workspace…`;
      const settled = `Your access changed${detail}. Please refresh or sign in again.`;
      setError(refreshing);
      Promise.resolve(onForbidden(caught))
        .catch((nextError) => handleApiError(nextError))
        .finally(() => {
          forbiddenHandoffRef.current = false;
          setError((current) => current === refreshing ? settled : current);
        });
      return;
    }
    setError(caught?.message || 'Something went wrong. Please try again.');
  }, [onForbidden, onUnauthorized]);

  const loadQueue = useCallback(async ({ preserveError = false } = {}) => {
    const requestId = ++queueRequestRef.current;
    setLoading(true);
    if (!preserveError) setError('');
    try {
      const params = new URLSearchParams({
        page: String(pagination.page),
        limit: String(PAGE_SIZE)
      });
      if (filters.status) params.set('status', filters.status);
      if (filters.priority) params.set('priority', filters.priority);
      if (filters.assigneeId) params.set('assigneeId', filters.assigneeId);
      if (filters.search.trim()) params.set('search', filters.search.trim());

      const [ticketResult, summaryResult, assigneeResult] = await Promise.allSettled([
        apiRequest(`/tickets?${params.toString()}`),
        apiRequest('/tickets/summary'),
        apiRequest('/tickets/assignees')
      ]);
      if (requestId !== queueRequestRef.current) return;

      const metadataResults = [summaryResult, assigneeResult];
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
      const responsePage = Number(ticketList.meta?.page ?? pagination.page);
      const totalPages = Math.max(1, Number(ticketList.meta?.totalPages ?? 1));
      setTickets(ticketList.data);
      setPagination({
        page: Math.min(responsePage, totalPages),
        limit: Number(ticketList.meta?.limit ?? PAGE_SIZE),
        total: Number(ticketList.meta?.total ?? ticketList.data.length),
        totalPages
      });
      if (summaryResult.status === 'fulfilled') setSummary(summaryResult.value.data);
      if (assigneeResult.status === 'fulfilled') setAssignees(assigneeResult.value.data.assignees);
      if (metadataResults.some((result) => result.status === 'rejected')) {
        setError('The queue loaded, but some workspace details could not be refreshed.');
      }
    } catch (caught) {
      if (requestId === queueRequestRef.current) handleApiError(caught);
    } finally {
      if (requestId === queueRequestRef.current) setLoading(false);
    }
  }, [filters, pagination.page, handleApiError]);

  const loadUsers = useCallback(async () => {
    const requestId = ++usersRequestRef.current;
    setUsersLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        page: String(userPagination.page),
        limit: String(PAGE_SIZE)
      });
      if (userFilters.search.trim()) params.set('search', userFilters.search.trim());
      if (userFilters.role) params.set('role', userFilters.role);
      if (userFilters.isActive) params.set('isActive', userFilters.isActive);
      const response = await apiRequest(`/users?${params.toString()}`);
      if (requestId !== usersRequestRef.current) return;

      const responsePage = Number(response.meta?.page ?? userPagination.page);
      const totalPages = Math.max(1, Number(response.meta?.totalPages ?? 1));
      setUsers(response.data);
      setUserPagination({
        page: Math.min(responsePage, totalPages),
        limit: Number(response.meta?.limit ?? PAGE_SIZE),
        total: Number(response.meta?.total ?? response.data.length),
        totalPages
      });
    } catch (caught) {
      if (requestId === usersRequestRef.current) handleApiError(caught);
    } finally {
      if (requestId === usersRequestRef.current) setUsersLoading(false);
    }
  }, [userPagination.page, userFilters, handleApiError]);

  const loadAudit = useCallback(async () => {
    const requestId = ++auditRequestRef.current;
    setAuditLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        page: String(auditPagination.page),
        limit: String(PAGE_SIZE)
      });
      if (auditFilters.action.trim()) params.set('action', auditFilters.action.trim());
      if (auditFilters.entityType.trim()) params.set('entityType', auditFilters.entityType.trim());
      if (auditFilters.from) params.set('from', auditFilters.from);
      if (auditFilters.to) params.set('to', auditFilters.to);
      const response = await apiRequest(`/audit-logs?${params.toString()}`);
      if (requestId !== auditRequestRef.current) return;
      setAuditLogs(response.data);
      setAuditPagination({
        page: Number(response.meta?.page ?? auditPagination.page),
        limit: Number(response.meta?.limit ?? PAGE_SIZE),
        total: Number(response.meta?.total ?? response.data.length),
        totalPages: Math.max(1, Number(response.meta?.totalPages ?? 1))
      });
    } catch (caught) {
      if (requestId === auditRequestRef.current) handleApiError(caught);
    } finally {
      if (requestId === auditRequestRef.current) setAuditLoading(false);
    }
  }, [auditFilters, auditPagination.page, handleApiError]);

  const loadCategories = useCallback(async () => {
    const requestId = ++categoriesRequestRef.current;
    setCategoriesLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        page: String(categoryPagination.page),
        limit: String(PAGE_SIZE),
        includeInactive: 'true'
      });
      const response = await apiRequest(`/categories/admin?${params.toString()}`);
      if (requestId !== categoriesRequestRef.current) return;
      setCategories(response.data);
      setCategoryPagination({
        page: Number(response.meta?.page ?? categoryPagination.page),
        limit: Number(response.meta?.limit ?? PAGE_SIZE),
        total: Number(response.meta?.total ?? response.data.length),
        totalPages: Math.max(1, Number(response.meta?.totalPages ?? 1))
      });
    } catch (caught) {
      if (requestId === categoriesRequestRef.current) handleApiError(caught);
    } finally {
      if (requestId === categoriesRequestRef.current) setCategoriesLoading(false);
    }
  }, [categoryPagination.page, handleApiError]);

  const loadSla = useCallback(async () => {
    const requestId = ++slaRequestRef.current;
    setSlaLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        page: String(slaPagination.page),
        limit: String(PAGE_SIZE)
      });
      if (slaFilters.slaStatus) params.set('slaStatus', slaFilters.slaStatus);
      if (slaFilters.priority) params.set('priority', slaFilters.priority);
      if (slaFilters.from) params.set('from', slaFilters.from);
      if (slaFilters.to) params.set('to', slaFilters.to);

      const isAdmin = user.role === 'admin';
      const [rulesResult, reportResult] = await Promise.allSettled([
        isAdmin ? apiRequest('/sla/rules') : Promise.resolve(null),
        apiRequest(`/sla/report?${params.toString()}`)
      ]);
      if (requestId !== slaRequestRef.current) return;

      if (reportResult.status === 'fulfilled') {
        const reportResponse = reportResult.value;
        setSlaReport(reportResponse.data);
        const responsePage = Number(reportResponse.meta?.page ?? slaPagination.page);
        const totalPages = Math.max(1, Number(reportResponse.meta?.totalPages ?? 1));
        setSlaPagination({
          page: Math.min(responsePage, totalPages),
          limit: Number(reportResponse.meta?.limit ?? PAGE_SIZE),
          total: Number(reportResponse.meta?.total ?? (reportResponse.data?.tickets?.length ?? 0)),
          totalPages
        });
      } else {
        setSlaReport(null);
        handleApiError(reportResult.reason);
      }

      if (isAdmin) {
        if (rulesResult.status === 'fulfilled') {
          setSlaRules(rulesResult.value.data);
        } else {
          handleApiError(rulesResult.reason);
        }
      }
    } catch (caught) {
      if (requestId === slaRequestRef.current) handleApiError(caught);
    } finally {
      if (requestId === slaRequestRef.current) setSlaLoading(false);
    }
  }, [user.role, slaFilters, slaPagination.page, handleApiError]);

  useEffect(() => {
    if (view === 'queue') loadQueue();
  }, [view, filters, pagination.page, loadQueue]);

  useEffect(() => {
    if (view === 'users' && user.role === 'admin') loadUsers();
  }, [view, user.role, userPagination.page, loadUsers]);

  useEffect(() => {
    if (view === 'audit' && user.role === 'admin') loadAudit();
  }, [view, user.role, loadAudit]);

  useEffect(() => {
    if (view === 'categories' && user.role === 'admin') loadCategories();
  }, [view, user.role, loadCategories]);

  useEffect(() => {
    if (view === 'sla') loadSla();
  }, [view, loadSla]);

  useEffect(() => {
    if (view === 'analytics' && user.role === 'admin') loadAnalytics();
  }, [view, user.role]);

  useEffect(() => {
    if (route.area !== 'staff') {
      navigateTo(STAFF_PATHS.queue, { replace: true });
      return;
    }
    if (adminViews.includes(requestedView) && user.role !== 'admin') {
      navigateTo(STAFF_PATHS.queue, { replace: true });
    }
  }, [route.area, requestedView, user.role]);

  useEffect(() => {
    if (view !== 'detail') {
      detailRouteRef.current = null;
      return;
    }
    const key = String(route.ticketId);
    if (detailRouteRef.current === key && selectedTicket
      && Number(selectedTicket.id) === Number(route.ticketId)) return;
    detailRouteRef.current = key;
    openTicket(route.ticketId);
  }, [view, route.ticketId]);

  const refreshSelectedTicket = useCallback(async (id) => {
    const requestId = ++detailRequestRef.current;
    try {
      const response = await apiRequest(`/tickets/${id}`);
      if (requestId !== detailRequestRef.current) return false;
      const ticket = response.data.ticket;
      setSelectedTicket({ ...ticket, assigneeOptions: assignees });
      const draft = formRef.current;
      setForm({
        ...formFromTicket(ticket),
        comment: draft.comment ?? '',
        isInternal: Boolean(draft.isInternal)
      });
      return true;
    } catch (caught) {
      if (requestId === detailRequestRef.current) handleApiError(caught);
      return false;
    }
  }, [assignees, handleApiError]);

  const loadAnalytics = useCallback(async (weeksValue = analyticsWeeks) => {
    const requestId = ++analyticsRequestRef.current;
    setAnalyticsLoading(true);
    setAnalyticsError('');
    try {
      const response = await apiRequest(`/dashboard/overview?weeks=${weeksValue}`);
      if (requestId !== analyticsRequestRef.current) return;
      setAnalytics(response.data);
    } catch (caught) {
      if (requestId !== analyticsRequestRef.current) return;
      if (caught?.status === 401 || caught?.status === 403) {
        setAnalytics(null);
        handleApiError(caught);
        return;
      }
      setAnalytics(null);
      setAnalyticsError(caught?.message || 'Analytics could not be loaded.');
    } finally {
      if (requestId === analyticsRequestRef.current) setAnalyticsLoading(false);
    }
  }, [analyticsWeeks, handleApiError]);

  function changeView(next) {
    detailRequestRef.current += 1;
    if (view === 'analytics' && next !== 'analytics') analyticsRequestRef.current += 1;
    setDetailLoading(false);
    setNotice('');
    setError('');
    if (next !== 'detail') setSelectedTicket(null);
    navigateTo(STAFF_PATHS[next] ?? STAFF_PATHS.queue);
  }

  function updateFilter(field, value) {
    setFilters((current) => ({ ...current, [field]: value }));
    setPagination((current) => ({ ...current, page: 1 }));
  }

  function updateForm(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function openTicket(id) {
    const requestId = ++detailRequestRef.current;
    setError('');
    setNotice('');
    setSelectedTicket(null);
    setDetailLoading(true);
    try {
      const response = await apiRequest(`/tickets/${id}`);
      if (requestId !== detailRequestRef.current) return;
      const ticket = response.data.ticket;
      setSelectedTicket({ ...ticket, assigneeOptions: assignees });
      setForm(formFromTicket(ticket));
      detailRouteRef.current = String(id);
      navigateTo(STAFF_PATHS.detail(id));
    } catch (caught) {
      if (requestId === detailRequestRef.current) {
        detailRouteRef.current = null;
        handleApiError(caught);
        if (view === 'detail') navigateTo(STAFF_PATHS.queue, { replace: true });
      }
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  }

  async function runAction(request, successMessage) {
    if (!selectedTicket) return false;
    const id = selectedTicket.id;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(id);
      const refreshed = await refreshSelectedTicket(id);
      if (!refreshed) return false;
      setNotice(successMessage);
      await loadQueue({ preserveError: true });
      return true;
    } catch (caught) {
      handleApiError(caught);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function handleAssign() {
    const assigneeId = form.assigneeId ? Number(form.assigneeId) : null;
    return runAction(
      (id) => apiRequest(`/tickets/${id}/assign`, { method: 'PATCH', body: { assigneeId } }),
      assigneeId === null ? 'Ticket unassigned.' : 'Assignment updated.'
    );
  }

  function handleStatus() {
    if (!selectedTicket || !allowedStatuses(selectedTicket.status).includes(form.status)) {
      return Promise.resolve();
    }
    const body = { status: form.status };
    if (form.status === 'Resolved') {
      const resolutionNotes = form.resolutionNotes.trim();
      if (resolutionNotes.length < 3) {
        setError('Resolution notes are required (at least 3 characters) before resolving a ticket.');
        return Promise.resolve();
      }
      body.resolutionNotes = resolutionNotes;
    }
    return runAction(
      (id) => apiRequest(`/tickets/${id}/status`, { method: 'PATCH', body }),
      `Ticket moved to ${form.status}.`
    );
  }

  function handlePriority() {
    return runAction(
      (id) => apiRequest(`/tickets/${id}/priority`, { method: 'PATCH', body: { priority: form.priority } }),
      `Priority updated to ${form.priority}.`
    );
  }

  function handleComment() {
    const body = form.comment.trim();
    if (!body) return Promise.resolve();
    return runAction(
      (id) => apiRequest(`/tickets/${id}/comments`, {
        method: 'POST',
        body: { body, isInternal: form.isInternal }
      }),
      form.isInternal ? 'Internal note added.' : 'Reply sent.'
    ).then((succeeded) => {
      if (succeeded) {
        setForm((current) => ({ ...current, comment: '', isInternal: false }));
      }
      return succeeded;
    });
  }

  async function runUserAction(request, successMessage) {
    setBusy(true);
    try {
      await request();
      setError('');
      setNotice(successMessage);
      await loadUsers();
      return true;
    } catch (caught) {
      handleApiError(caught);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function runAdminAction(request, successMessage, reload) {
    setBusy(true);
    try {
      await request();
      setError('');
      setNotice(successMessage);
      await reload();
      return true;
    } catch (caught) {
      handleApiError(caught);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateUser() {
    const payload = { ...userForm };
    const created = await runUserAction(
      () => apiRequest('/users', { method: 'POST', body: payload }),
      'User created.'
    );
    if (created) setUserForm(EMPTY_USER_FORM);
  }

  function handleEditUser(target) {
    setEditingUser(target);
    setUserForm({
      firstName: target.firstName,
      lastName: target.lastName,
      email: target.email,
      password: '',
      role: target.role
    });
  }

  async function handleSaveUser() {
    if (!editingUser) return;
    const saved = await runUserAction(
      () => apiRequest(`/users/${editingUser.id}`, {
        method: 'PATCH',
        body: {
          firstName: userForm.firstName,
          lastName: userForm.lastName,
          email: userForm.email,
          role: userForm.role
        }
      }),
      'User updated.'
    );
    if (saved) {
      setEditingUser(null);
      setUserForm(EMPTY_USER_FORM);
    }
  }

  function handleChangeUserFilter(field, value) {
    setUserFilters((current) => ({ ...current, [field]: value }));
    setUserPagination((current) => ({ ...current, page: 1 }));
  }

  function handleToggleUser(target) {
    return runUserAction(
      () => apiRequest(`/users/${target.id}`, {
        method: 'PATCH',
        body: { isActive: !target.isActive }
      }),
      target.isActive ? 'User disabled.' : 'User enabled.'
    );
  }

  function handleUserRole(target, role) {
    return runUserAction(
      () => apiRequest(`/users/${target.id}`, { method: 'PATCH', body: { role } }),
      'Role updated.'
    );
  }

  function handleChangeAuditFilter(field, value) {
    if (field === 'reset') {
      setAuditFilters({ action: '', entityType: '', from: '', to: '' });
    } else {
      setAuditFilters((current) => ({ ...current, [field]: value }));
    }
    setAuditPagination((current) => ({ ...current, page: 1 }));
  }

  function handleCreateCategory(form) {
    return runAdminAction(
      () => apiRequest('/categories', { method: 'POST', body: form }),
      'Category created.',
      loadCategories
    );
  }

  function handleUpdateCategory(id, form) {
    return runAdminAction(
      () => apiRequest(`/categories/${id}`, { method: 'PATCH', body: form }),
      'Category updated.',
      loadCategories
    );
  }

  function handleToggleCategory(category) {
    return runAdminAction(
      () => apiRequest(`/categories/${category.id}`, {
        method: 'PATCH',
        body: { isActive: !category.isActive }
      }),
      category.isActive ? 'Category disabled.' : 'Category enabled.',
      loadCategories
    );
  }

  function handleCreateSubcategory(categoryId, name) {
    return runAdminAction(
      () => apiRequest(`/categories/${categoryId}/subcategories`, {
        method: 'POST',
        body: { name }
      }),
      'Subcategory created.',
      loadCategories
    );
  }

  function handleToggleSubcategory(category, subcategory) {
    return runAdminAction(
      () => apiRequest(`/categories/${category.id}/subcategories/${subcategory.id}`, {
        method: 'PATCH',
        body: { isActive: !subcategory.isActive }
      }),
      subcategory.isActive ? 'Subcategory disabled.' : 'Subcategory enabled.',
      loadCategories
    );
  }

  function updateUserForm(field, value) {
    setUserForm((current) => ({ ...current, [field]: value }));
  }

  function updateSlaFilter(field, value) {
    setSlaFilters((current) => ({ ...current, [field]: value }));
    setSlaPagination((current) => ({ ...current, page: 1 }));
  }

  function changeSlaPage(page) {
    setNotice('');
    setError('');
    setSlaPagination((current) => ({ ...current, page }));
  }

  async function handleSaveRule(id, draft) {
    setSlaBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await apiRequest(`/sla/rules/${id}`, {
        method: 'PATCH',
        body: {
          responseMinutes: Number(draft.responseMinutes),
          isActive: Boolean(draft.isActive)
        }
      });
      setNotice('SLA rule updated.');
      const updated = response.data?.rule;
      if (updated) {
        setSlaRules((current) => current.map((rule) => (
          rule.id === updated.id ? updated : rule
        )));
      } else {
        await loadSla();
      }
    } catch (caught) {
      handleApiError(caught);
    } finally {
      setSlaBusy(false);
    }
  }

  const hasFilters = Boolean(filters.status || filters.priority || filters.assigneeId || filters.search.trim());

  return (
    <>
      <header className="app-header staff-header">
        <div className="brand">
          <span className="brand-mark">HD</span>
          <span>HelpDesk Pro</span>
          <span className="brand-portal">Staff workspace</span>
        </div>
        <nav className="staff-nav" aria-label="Staff sections">
          <button
            type="button"
            className={`button button-link${view === 'queue' || view === 'detail' ? ' button-active' : ''}`}
            aria-current={view === 'queue' || view === 'detail' ? 'page' : undefined}
            onClick={() => changeView('queue')}
          >
            Ticket queue
          </button>
          <button
            type="button"
            className={`button button-link${view === 'sla' ? ' button-active' : ''}`}
            aria-current={view === 'sla' ? 'page' : undefined}
            onClick={() => changeView('sla')}
          >
            SLA
          </button>
          {user.role === 'admin' && (
            <button
              type="button"
              className={`button button-link${view === 'analytics' ? ' button-active' : ''}`}
              aria-current={view === 'analytics' ? 'page' : undefined}
              onClick={() => changeView('analytics')}
            >
              Analytics
            </button>
          )}
          {user.role === 'admin' && (
            <button
              type="button"
              className={`button button-link${view === 'users' ? ' button-active' : ''}`}
              aria-current={view === 'users' ? 'page' : undefined}
              onClick={() => changeView('users')}
            >
              Users
            </button>
          )}
          {user.role === 'admin' && (
            <button
              type="button"
              className={`button button-link${view === 'categories' ? ' button-active' : ''}`}
              aria-current={view === 'categories' ? 'page' : undefined}
              onClick={() => changeView('categories')}
            >
              Categories
            </button>
          )}
          {user.role === 'admin' && (
            <button
              type="button"
              className={`button button-link${view === 'audit' ? ' button-active' : ''}`}
              aria-current={view === 'audit' ? 'page' : undefined}
              onClick={() => changeView('audit')}
            >
              Audit
            </button>
          )}
        </nav>
        <div className="header-actions">
          <span className="user-label">{user.firstName} {user.lastName}</span>
          <span className="role-pill">{user.role}</span>
          <button type="button" className="button button-link" onClick={() => setShowSessions(true)}>
            Sessions
          </button>
          <ThemeToggle />
          <button type="button" className="button button-secondary" onClick={onLogout} disabled={loggingOut}>
            {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      <main className="app-main">
        <Notice message={notice} />
        <ErrorBanner message={error} onDismiss={() => setError('')} />

        {view === 'analytics' ? (
          <AsyncBoundary
            resetKey={`${analyticsWeeks}:${analyticsAttempt}`}
            onRetry={retryAnalytics}
            title="Charts unavailable"
          >
            <Suspense fallback={<p className="muted">Loading charts…</p>}>
              <AnalyticsPanel
                data={analytics}
                loading={analyticsLoading}
                error={analyticsError}
                weeks={analyticsWeeks}
                onWeeksChange={(value) => {
                  setAnalyticsWeeks(value);
                  loadAnalytics(value);
                }}
                onRefresh={() => loadAnalytics()}
              />
            </Suspense>
          </AsyncBoundary>
        ) : view === 'sla' ? (
          <SlaPanel
            rules={slaRules}
            report={slaReport}
            isAdmin={user.role === 'admin'}
            filters={slaFilters}
            pagination={slaPagination}
            loading={slaLoading}
            busy={slaBusy}
            onChangeFilter={updateSlaFilter}
            onPageChange={changeSlaPage}
            onSaveRule={handleSaveRule}
          />
        ) : view === 'categories' ? (
          <CategoriesPanel
            categories={categories}
            pagination={categoryPagination}
            loading={categoriesLoading}
            busy={busy}
            error={error}
            onCreate={handleCreateCategory}
            onUpdate={handleUpdateCategory}
            onToggle={handleToggleCategory}
            onCreateSubcategory={handleCreateSubcategory}
            onToggleSubcategory={handleToggleSubcategory}
            onPageChange={(page) => {
              setNotice('');
              setError('');
              setCategoryPagination((current) => ({ ...current, page }));
            }}
            onRefresh={loadCategories}
          />
        ) : view === 'audit' ? (
          <AuditPanel
            logs={auditLogs}
            pagination={auditPagination}
            filters={auditFilters}
            loading={auditLoading}
            error={error}
            onFilterChange={handleChangeAuditFilter}
            onPageChange={(page) => {
              setNotice('');
              setError('');
              setAuditPagination((current) => ({ ...current, page }));
            }}
            onRefresh={loadAudit}
          />
        ) : view === 'users' ? (
          <UsersPanel
            users={users}
            pagination={userPagination}
            form={userForm}
            filters={userFilters}
            editingUser={editingUser}
            currentUserId={user.id}
            onChangeForm={updateUserForm}
            onChangeFilter={handleChangeUserFilter}
            onCreate={handleCreateUser}
            onEdit={handleEditUser}
            onSaveEdit={handleSaveUser}
            onCancelEdit={() => { setEditingUser(null); setUserForm(EMPTY_USER_FORM); }}
            onToggle={handleToggleUser}
            onRoleChange={handleUserRole}
            onPageChange={(page) => {
              setNotice('');
              setError('');
              setUserPagination((current) => ({ ...current, page }));
            }}
            busy={busy}
            loading={usersLoading}
          />
        ) : view === 'detail' && selectedTicket
          && Number(selectedTicket.id) === Number(route.ticketId) ? (
          <StaffTicketDetail
            ticket={selectedTicket}
            form={form}
            onFormChange={updateForm}
            onBack={() => changeView('queue')}
            onAssign={handleAssign}
            onStatus={handleStatus}
            onPriority={handlePriority}
            onComment={handleComment}
            onApiError={handleApiError}
            currentUser={user}
            busy={busy}
          />
        ) : view === 'detail' ? (
          <section className="panel">
            {detailLoading ? <p className="muted">Loading ticket…</p> : (
              <>
                <p className="muted">This ticket is no longer available.</p>
                <button type="button" className="button button-secondary" onClick={() => changeView('queue')}>
                  Back to queue
                </button>
              </>
            )}
          </section>
        ) : (
          <>
            <div className="page-heading">
              <div>
                <span className="eyebrow">Service desk</span>
                <h1>Ticket queue</h1>
                <p className="muted">Triage, assign and resolve requests from your employees.</p>
              </div>
            </div>

            <section className="stats-grid" aria-label="Queue summary">
              <StatCard label="Open" value={summary?.open} tone="info" />
              <StatCard label="Unassigned" value={summary?.unassigned} />
              <StatCard label="Overdue SLA" value={summary?.overdue} tone="danger" />
              <StatCard label="Resolved" value={summary?.resolved} tone="success" />
              <StatCard label="Closed" value={summary?.closed} />
            </section>

            <section className="panel">
              <div className="list-heading">
                <h2>All tickets</h2>
                <div className="filters">
                  <label className="sr-only" htmlFor="staff-status-filter">Filter by status</label>
                  <select
                    id="staff-status-filter"
                    value={filters.status}
                    onChange={(event) => updateFilter('status', event.target.value)}
                  >
                    <option value="">All statuses</option>
                    {STATUSES.map((status) => <option key={status}>{status}</option>)}
                  </select>
                  <label className="sr-only" htmlFor="staff-priority-filter">Filter by priority</label>
                  <select
                    id="staff-priority-filter"
                    value={filters.priority}
                    onChange={(event) => updateFilter('priority', event.target.value)}
                  >
                    <option value="">All priorities</option>
                    {PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}
                  </select>
                  <label className="sr-only" htmlFor="staff-assignee-filter">Filter by assignee</label>
                  <select
                    id="staff-assignee-filter"
                    value={filters.assigneeId}
                    onChange={(event) => updateFilter('assigneeId', event.target.value)}
                  >
                    <option value="">All assignees</option>
                    <option value="unassigned">Unassigned</option>
                    {assignees.map((assignee) => (
                      <option key={assignee.id} value={assignee.id}>{assignee.name}</option>
                    ))}
                  </select>
                  <label className="sr-only" htmlFor="staff-ticket-search">Search tickets</label>
                  <input
                    id="staff-ticket-search"
                    type="search"
                    placeholder="Search tickets"
                    value={filters.search}
                    onChange={(event) => updateFilter('search', event.target.value)}
                  />
                </div>
              </div>
              {loading ? <p className="muted">Loading queue…</p> : (
                <>
                  <StaffTicketList tickets={tickets} onSelect={openTicket} filtered={hasFilters} />
                  <Pagination
                    pagination={pagination}
                    onPageChange={(page) => {
                      setNotice('');
                      setError('');
                      setPagination((current) => ({ ...current, page }));
                    }}
                  />
                </>
              )}
            </section>
          </>
        )}
      </main>
      {showSessions && (
        <SessionsPanel
          onClose={() => setShowSessions(false)}
          onUnauthorized={onUnauthorized}
        />
      )}
    </>
  );
}
