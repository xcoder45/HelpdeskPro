-- Migration 008 used a custom GUC as the DELETE bypass for retention. Any role
-- with DELETE privilege could set that GUC itself, so the bypass is now bound
-- to a dedicated, non-login retention owner. The application role keeps only
-- the SELECT/INSERT/UPDATE rights it needs and cannot delete history rows.

CREATE TEMP TABLE helpdesk_migration_retention_membership (
  was_member boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO helpdesk_migration_retention_membership (was_member)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helpdesk_retention')
  THEN pg_has_role(current_user, 'helpdesk_retention', 'MEMBER')
  ELSE false
END;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helpdesk_retention') THEN
    CREATE ROLE helpdesk_retention NOLOGIN;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT (SELECT was_member FROM helpdesk_migration_retention_membership) THEN
    GRANT helpdesk_retention TO current_user;
  END IF;
END
$$;

REVOKE ALL ON public.ticket_history, public.audit_logs FROM PUBLIC, CURRENT_USER;
GRANT SELECT, INSERT, UPDATE ON public.ticket_history, public.audit_logs TO CURRENT_USER;

CREATE OR REPLACE FUNCTION public.reject_append_only_mutation()
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

  IF TG_OP = 'DELETE'
     AND current_user = 'helpdesk_retention'
     AND current_setting('helpdesk_pro.retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION '% records are append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_expired_activity(
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

ALTER TABLE public.ticket_history OWNER TO helpdesk_retention;
ALTER TABLE public.audit_logs OWNER TO helpdesk_retention;
ALTER FUNCTION public.reject_append_only_mutation() OWNER TO helpdesk_retention;
ALTER FUNCTION public.purge_expired_activity(integer, integer) OWNER TO helpdesk_retention;

REVOKE ALL ON FUNCTION public.purge_expired_activity(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_expired_activity(integer, integer) TO CURRENT_USER;

DO $$
BEGIN
  IF NOT (SELECT was_member FROM helpdesk_migration_retention_membership) THEN
    REVOKE helpdesk_retention FROM current_user;
  END IF;
END
$$;
