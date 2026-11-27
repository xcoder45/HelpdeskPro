-- Completing the ownership transfer in 011: changing a table owner does not
-- replace an existing ACL, so the retention owner needs an explicit grant of
-- DELETE before purge_expired_activity() can remove aged history rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helpdesk_retention') THEN
    GRANT ALL ON public.ticket_history, public.audit_logs TO helpdesk_retention;
    GRANT ALL ON FUNCTION public.purge_expired_activity(integer, integer) TO helpdesk_retention;
    GRANT ALL ON FUNCTION public.reject_append_only_mutation() TO helpdesk_retention;
  END IF;
END
$$;
