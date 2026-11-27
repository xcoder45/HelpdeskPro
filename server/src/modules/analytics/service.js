import { withTransaction } from '../../db/transaction.js';

export const OPEN_STATUSES = ['New', 'Assigned', 'In Progress', 'Pending'];
export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];

// Resolution history is append-only, so reopening a ticket must not erase past resolutions.
// A new working period starts after a status change out of Resolved/Closed.
const RESOLUTION_EVENTS_CTE = `
  WITH resolution_events AS (
    SELECT
      h.ticket_id,
      h.created_at AS resolved_at,
      COALESCE(
        (
          SELECT max(reopened.created_at)
          FROM ticket_history reopened
          WHERE reopened.ticket_id = h.ticket_id
            AND reopened.action = 'status_changed'
            AND reopened.old_value IN ('Resolved', 'Closed')
            AND reopened.new_value NOT IN ('Resolved', 'Closed')
            AND reopened.created_at < h.created_at
        ),
        t.created_at
      ) AS started_at
    FROM ticket_history h
    JOIN tickets t ON t.id = h.ticket_id
    WHERE h.action = 'status_changed'
      AND h.new_value = 'Resolved'
      AND NOT EXISTS (
        SELECT 1
        FROM ticket_history cancelled
        WHERE cancelled.ticket_id = h.ticket_id
          AND cancelled.action = 'cancelled'
          AND cancelled.created_at <= h.created_at
          AND NOT EXISTS (
            SELECT 1
            FROM ticket_history restarted
            WHERE restarted.ticket_id = cancelled.ticket_id
              AND restarted.created_at > cancelled.created_at
              AND restarted.created_at <= h.created_at
              AND (
                restarted.action = 'reopened'
                OR (
                  restarted.action = 'status_changed'
                  AND restarted.old_value IN ('Resolved', 'Closed')
                  AND restarted.new_value NOT IN ('Resolved', 'Closed')
                )
              )
          )
      )
  )
`;

async function snapshotTime(client) {
  const { rows } = await client.query('SELECT now() AS value');
  return rows[0].value;
}

export async function getDashboardSummary(client, now) {
  const { rows } = await client.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE status = ANY($1::text[]))::int AS open,
       count(*) FILTER (WHERE assignee_id IS NULL AND status = ANY($1::text[]))::int AS unassigned,
       count(*) FILTER (WHERE status = 'Resolved')::int AS resolved,
       count(*) FILTER (WHERE status = 'Closed' AND cancelled_at IS NULL)::int AS closed,
       count(*) FILTER (WHERE cancelled_at IS NOT NULL)::int AS cancelled,
       count(*) FILTER (
         WHERE first_responded_at IS NULL
           AND response_due_at < $2::timestamptz
           AND status = ANY($1::text[])
       )::int AS overdue
     FROM tickets`,
    [OPEN_STATUSES, now]
  );
  return rows[0];
}

export async function getPriorityBreakdown(client) {
  const { rows } = await client.query(
    `SELECT p.priority, count(t.id)::int AS total
     FROM unnest($1::text[]) AS p(priority)
     LEFT JOIN tickets t ON t.priority = p.priority
     GROUP BY p.priority, array_position($1::text[], p.priority)
     ORDER BY array_position($1::text[], p.priority)`,
    [PRIORITIES]
  );
  return rows;
}

export async function getCategoryBreakdown(client) {
  const { rows } = await client.query(
    `SELECT c.name AS category, count(t.id)::int AS total
     FROM categories c
     LEFT JOIN tickets t ON t.category_id = c.id
     WHERE c.is_active = true
        OR EXISTS (SELECT 1 FROM tickets WHERE category_id = c.id)
     GROUP BY c.id, c.name
     ORDER BY total DESC, c.name ASC`
  );
  return rows;
}

export async function getWeeklyTrends(client, now, weeks) {
  const { rows } = await client.query(
    `${RESOLUTION_EVENTS_CTE},
     weeks AS (
       SELECT generate_series(
         date_trunc('week', $1::timestamptz) - (($2::int - 1) * interval '1 week'),
         date_trunc('week', $1::timestamptz),
         interval '1 week'
       ) AS week_start
     )
     SELECT to_char(w.week_start, 'YYYY-MM-DD') AS week_start,
            to_char(w.week_start, 'Mon DD') AS label,
            count(DISTINCT t.id) FILTER (
              WHERE t.created_at >= w.week_start
                AND t.created_at < w.week_start + interval '1 week'
            )::int AS created,
            count(DISTINCT re.ticket_id) FILTER (
              WHERE re.resolved_at >= w.week_start
                AND re.resolved_at < w.week_start + interval '1 week'
            )::int AS resolved
     FROM weeks w
     LEFT JOIN tickets t
       ON t.created_at >= w.week_start
       AND t.created_at < w.week_start + interval '1 week'
     LEFT JOIN resolution_events re
       ON re.resolved_at >= w.week_start
       AND re.resolved_at < w.week_start + interval '1 week'
     GROUP BY w.week_start
     ORDER BY w.week_start`,
    [now, weeks]
  );
  return rows.map((row) => ({
    weekStart: row.week_start,
    label: row.label,
    created: Number(row.created),
    resolved: Number(row.resolved)
  }));
}

export async function getAgentWorkload(client) {
  const { rows } = await client.query(
    `SELECT u.id,
            u.first_name || ' ' || u.last_name AS name,
            count(t.id) FILTER (
              WHERE t.assignee_id = u.id AND t.status = ANY($1::text[])
            )::int AS open,
            count(t.id) FILTER (WHERE t.assignee_id = u.id)::int AS assigned,
            count(t.id) FILTER (
              WHERE t.assignee_id = u.id
                AND t.status IN ('Resolved', 'Closed')
                AND t.cancelled_at IS NULL
            )::int AS completed
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN tickets t ON t.assignee_id = u.id
     WHERE r.name IN ('agent', 'admin') AND u.is_active = true
     GROUP BY u.id, name
     ORDER BY open DESC, name ASC`,
    [OPEN_STATUSES]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    open: Number(row.open),
    assigned: Number(row.assigned),
    completed: Number(row.completed)
  }));
}

export async function getAverageResolutionTime(client) {
  const { rows } = await client.query(
    `${RESOLUTION_EVENTS_CTE}
     SELECT count(*)::int AS resolved_tickets,
            COALESCE(round(avg(extract(epoch FROM (resolved_at - started_at)) / 60))::int, 0)::int AS average_minutes
     FROM resolution_events`
  );
  return {
    resolvedTickets: Number(rows[0].resolved_tickets),
    averageResolutionMinutes: Number(rows[0].average_minutes)
  };
}

export async function getDashboardOverview(database, weeks) {
  return withTransaction(database, async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const now = await snapshotTime(client);
    return {
      summary: await getDashboardSummary(client, now),
      priority: await getPriorityBreakdown(client),
      category: await getCategoryBreakdown(client),
      weeklyTrends: await getWeeklyTrends(client, now, weeks),
      agentWorkload: await getAgentWorkload(client),
      averageResolutionTime: await getAverageResolutionTime(client)
    };
  });
}

export async function getSingleDashboardMetric(database, metric, weeks) {
  return withTransaction(database, async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const now = await snapshotTime(client);
    switch (metric) {
      case 'summary': return getDashboardSummary(client, now);
      case 'priority': return getPriorityBreakdown(client);
      case 'category': return getCategoryBreakdown(client);
      case 'weeklyTrends': return getWeeklyTrends(client, now, weeks);
      case 'agentWorkload': return getAgentWorkload(client);
      case 'averageResolutionTime': return getAverageResolutionTime(client);
      default: throw new Error(`Unknown dashboard metric: ${metric}`);
    }
  });
}
