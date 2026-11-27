ALTER TABLE tickets ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

UPDATE tickets t
SET cancelled_at = h.created_at
FROM ticket_history h
WHERE h.ticket_id = t.id
  AND h.action = 'cancelled'
  AND t.cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tickets_resolved_at ON tickets (resolved_at);
