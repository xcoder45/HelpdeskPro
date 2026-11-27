// Shared SLA derivation. Every ticket query uses the database clock so the
// values stay consistent with deadlines stored in PostgreSQL.
export const SLA_STATUS_SQL = `
  CASE
    WHEN t.first_responded_at IS NOT NULL AND t.first_responded_at <= t.response_due_at THEN 'met'
    WHEN t.first_responded_at IS NOT NULL THEN 'breached'
    WHEN t.status IN ('Resolved', 'Closed') THEN 'unverified'
    WHEN t.response_due_at < now() THEN 'breached'
    ELSE 'pending'
  END
`;

export const SLA_CALCULATION_SELECT = `
  ${SLA_STATUS_SQL} AS sla_status,
  CASE
    WHEN t.first_responded_at IS NULL AND t.status NOT IN ('Resolved', 'Closed')
      THEN ROUND(EXTRACT(EPOCH FROM (t.response_due_at - now())) / 60)::int
    ELSE NULL
  END AS sla_time_remaining_minutes,
  CASE
    WHEN t.first_responded_at IS NOT NULL
      THEN ROUND(EXTRACT(EPOCH FROM (t.first_responded_at - t.created_at)) / 60)::int
    ELSE NULL
  END AS sla_response_minutes,
  CASE
    WHEN t.resolved_at IS NOT NULL AND t.cancelled_at IS NULL
      THEN ROUND(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60)::int
    ELSE NULL
  END AS sla_resolution_minutes
`;
