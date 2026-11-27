-- Preserve ON DELETE SET NULL for append-only records while rejecting all
-- other updates and deletes. PostgreSQL implements the foreign-key action as
-- an UPDATE that only clears actor_id, so allow exactly that row change.
CREATE OR REPLACE FUNCTION reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.actor_id IS NOT NULL
     AND NEW.actor_id IS NULL
     AND to_jsonb(OLD) - 'actor_id' = to_jsonb(NEW) - 'actor_id' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% records are append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;

-- Make the cancellation backfill deterministic when a ticket was cancelled,
-- reopened, and cancelled again. The latest cancellation record is the value
-- that should appear in analytics.
UPDATE tickets t
SET cancelled_at = h.cancelled_at
FROM (
  SELECT ticket_id, MAX(created_at) AS cancelled_at
  FROM ticket_history
  WHERE action = 'cancelled'
  GROUP BY ticket_id
) h
WHERE h.ticket_id = t.id
  AND t.status = 'Closed'
  AND t.resolution_notes = 'Cancelled by requester';
