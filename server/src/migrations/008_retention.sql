-- Retention for append-only tables. The guard keeps the actor-nulling FK
-- exception from 006 and adds a narrowly scoped, transaction-local bypass used
-- only by purge_expired_activity(). Normal UPDATE/DELETE remains rejected.
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

  IF TG_OP = 'DELETE' AND current_setting('helpdesk_pro.retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION '% records are append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;

-- SECURITY DEFINER keeps the purge switch out of application queries. Execute
-- rights should be granted only to the maintenance role that runs retention.
CREATE OR REPLACE FUNCTION purge_expired_activity(
  p_audit_days integer,
  p_history_days integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_audit integer;
  v_history integer;
BEGIN
  IF p_audit_days IS NULL OR p_history_days IS NULL
     OR p_audit_days < 1 OR p_history_days < 1 THEN
    RAISE EXCEPTION 'retention periods must be positive day counts'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('helpdesk_pro.retention_purge', 'on', true);

  DELETE FROM audit_logs
  WHERE created_at < now() - make_interval(days => p_audit_days);
  GET DIAGNOSTICS v_audit = ROW_COUNT;

  DELETE FROM ticket_history
  WHERE created_at < now() - make_interval(days => p_history_days);
  GET DIAGNOSTICS v_history = ROW_COUNT;

  PERFORM set_config('helpdesk_pro.retention_purge', '', true);

  RETURN jsonb_build_object(
    'auditLogsDeleted', v_audit,
    'ticketHistoryDeleted', v_history
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION purge_expired_activity(integer, integer) FROM PUBLIC;
