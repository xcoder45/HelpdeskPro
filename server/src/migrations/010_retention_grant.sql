-- Migration 008 revokes EXECUTE from PUBLIC. Grant it back to the role that
-- runs migrations/maintenance so the CLI and scheduled retention job work in
-- least-privilege deployments without making the function public.
DO $$
BEGIN
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.purge_expired_activity(integer, integer) TO %I',
    current_user
  );
END
$$;
