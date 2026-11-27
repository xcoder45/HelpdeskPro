import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { StatCard, formatDuration } from './ui.jsx';

function hasPositiveValue(rows, keys) {
  return rows.some((row) => keys.some((key) => Number(row[key]) > 0));
}

function ChartCard({ title, description, hasData, children, tableLabel, table }) {
  return (
    <section className="panel analytics-chart">
      <h2>{title}</h2>
      {description && <p className="muted">{description}</p>}
      {hasData ? (
        <>
          <div className="chart-canvas" aria-hidden="true">
            <ResponsiveContainer width="100%" height={260}>
              {children}
            </ResponsiveContainer>
          </div>
          <div className="table-wrap">
            <table className="analytics-data-table">
              <caption className="sr-only">{tableLabel}</caption>
              <thead><tr>{table.headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr></thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.key}>{row.cells.map((cell, index) => (
                    index === 0
                      ? <th key={index} scope="row">{cell}</th>
                      : <td key={index}>{cell}</td>
                  ))}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="empty-state">No data available.</p>
      )}
    </section>
  );
}

export default function AnalyticsPanel({ data, loading, error, weeks, onWeeksChange, onRefresh }) {
  const summary = data?.summary ?? {};
  const average = data?.averageResolutionTime ?? {};
  const priority = data?.priority ?? [];
  const category = data?.category ?? [];
  const trends = data?.weeklyTrends ?? [];
  const workload = data?.agentWorkload ?? [];
  const hasResolutionData = Number(average.resolvedTickets) > 0
    && Number.isFinite(Number(average.averageResolutionMinutes));

  return (
    <section className="analytics-panel" aria-label="Analytics and reporting" aria-busy={loading}>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Reporting</span>
          <h1>Analytics</h1>
          <p className="muted">Service desk figures calculated directly from ticket records.</p>
          <p className="muted analytics-note">
            Overdue counts open tickets still waiting for a first response past their target.
            Full SLA breaches remain available in the SLA tab. Weekly trends keep prior
            resolutions even when a ticket is reopened.
          </p>
        </div>
        <div className="analytics-controls">
          <label htmlFor="analytics-weeks">Trend window</label>
          <select
            id="analytics-weeks"
            value={weeks}
            onChange={(event) => onWeeksChange(Number(event.target.value))}
            disabled={loading}
          >
            {[4, 8, 12].map((option) => <option key={option} value={option}>Last {option} weeks</option>)}
          </select>
          <button type="button" className="button button-secondary" onClick={onRefresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="banner banner-error" role="alert">{error}</div>}

      {loading && !data ? (
        <section className="panel"><p className="muted" role="status">Loading analytics…</p></section>
      ) : !data ? (
        <section className="panel"><p className="empty-state">Analytics are unavailable.</p></section>
      ) : (
        <>
          <section className="stats-grid" aria-label="Analytics summary">
            <StatCard label="Total incidents" value={summary.total} />
            <StatCard label="Open" value={summary.open} tone="info" />
            <StatCard label="Resolved" value={summary.resolved} tone="success" />
            <StatCard label="Overdue" value={summary.overdue} tone="danger" />
            <StatCard
              label="Average resolution"
              value={formatDuration(hasResolutionData ? average.averageResolutionMinutes : null)}
            />
          </section>

          <div className="analytics-grid">
            <ChartCard
              title="Incidents by priority"
              hasData={hasPositiveValue(priority, ['total'])}
              tableLabel="Incident counts by priority"
              table={{
                headers: ['Priority', 'Incidents'],
                rows: priority.map((row) => ({ key: row.priority, cells: [row.priority, row.total] }))
              }}
            >
              <BarChart data={priority} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="priority" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="total" name="Incidents" fill="#2563eb" isAnimationActive={false} />
              </BarChart>
            </ChartCard>

            <ChartCard
              title="Incidents by category"
              hasData={hasPositiveValue(category, ['total'])}
              tableLabel="Incident counts by category"
              table={{
                headers: ['Category', 'Incidents'],
                rows: category.map((row) => ({ key: row.category, cells: [row.category, row.total] }))
              }}
            >
              <BarChart data={category} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="category" interval={0} angle={-20} textAnchor="end" height={70} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="total" name="Incidents" fill="#7c3aed" isAnimationActive={false} />
              </BarChart>
            </ChartCard>

            <ChartCard
              title="Weekly incident trends"
              description={`Created and resolved tickets over the last ${weeks} weeks.`}
              hasData={hasPositiveValue(trends, ['created', 'resolved'])}
              tableLabel="Weekly created and resolved ticket counts"
              table={{
                headers: ['Week', 'Created', 'Resolved'],
                rows: trends.map((row) => ({ key: row.weekStart, cells: [row.label, row.created, row.resolved] }))
              }}
            >
              <LineChart data={trends} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="created"
                  name="Created"
                  stroke="#2563eb"
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="resolved"
                  name="Resolved"
                  stroke="#16a34a"
                  isAnimationActive={false}
                />
              </LineChart>
            </ChartCard>

            <ChartCard
              title="Agent workload"
              hasData={hasPositiveValue(workload, ['open', 'assigned', 'completed'])}
              tableLabel="Open and completed tickets by agent"
              table={{
                headers: ['Agent', 'Open', 'Completed'],
                rows: workload.map((row) => ({ key: row.id, cells: [row.name, row.open, row.completed] }))
              }}
            >
              <BarChart data={workload} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" interval={0} angle={-20} textAnchor="end" height={70} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Bar dataKey="open" name="Open" fill="#d97706" isAnimationActive={false} />
                <Bar dataKey="completed" name="Completed" fill="#16a34a" isAnimationActive={false} />
              </BarChart>
            </ChartCard>
          </div>
        </>
      )}
    </section>
  );
}
