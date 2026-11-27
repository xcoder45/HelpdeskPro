import { ErrorBanner, Pagination, formatDate } from './ui.jsx';

export default function AuditPanel({ logs, pagination, filters, loading, error, onFilterChange, onPageChange, onRefresh }) {
  return (
    <section className="staff-users" aria-busy={loading}>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Administration</span>
          <h1>Audit log</h1>
          <p className="muted">An append-only record of changes made in the service desk.</p>
        </div>
        <button type="button" className="button button-secondary" onClick={onRefresh} disabled={loading}>
          Refresh
        </button>
      </div>

      <ErrorBanner message={error} />

      <article className="panel">
        <div className="filter-bar">
          <label htmlFor="audit-action">Action</label>
          <input
            id="audit-action"
            value={filters.action}
            onChange={(event) => onFilterChange('action', event.target.value)}
            placeholder="ticket.status_changed"
          />
          <label htmlFor="audit-entity">Entity type</label>
          <input
            id="audit-entity"
            value={filters.entityType}
            onChange={(event) => onFilterChange('entityType', event.target.value)}
            placeholder="ticket"
          />
          <label htmlFor="audit-from">From</label>
          <input id="audit-from" type="date" value={filters.from} onChange={(event) => onFilterChange('from', event.target.value)} />
          <label htmlFor="audit-to">To</label>
          <input id="audit-to" type="date" value={filters.to} onChange={(event) => onFilterChange('to', event.target.value)} />
          <button type="button" className="button button-secondary" onClick={() => onFilterChange('reset', '')}>
            Clear filters
          </button>
        </div>

        {loading ? (
          <p className="muted">Loading audit log…</p>
        ) : logs.length === 0 ? (
          <p className="empty-state">No audit events match these filters.</p>
        ) : (
          <div className="table-wrap">
            <table className="ticket-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td>{formatDate(log.createdAt)}</td>
                    <td>{log.actorName ?? 'System'}</td>
                    <td>{log.action}</td>
                    <td>{log.entityType}{log.entityId ? ` #${log.entityId}` : ''}</td>
                    <td><code className="audit-details">{JSON.stringify(log.details)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pagination
          pagination={pagination}
          ariaLabel="Audit log pages"
          itemLabel="events"
          onPageChange={onPageChange}
        />
      </article>
    </section>
  );
}
