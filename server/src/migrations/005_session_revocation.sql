-- Per-user token version lets the server invalidate tokens issued before logout
-- without maintaining an in-memory denylist.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
