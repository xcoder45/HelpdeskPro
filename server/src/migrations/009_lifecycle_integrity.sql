-- Tighten lifecycle tokens: bind verification links to the address they were
-- issued for, guarantee one unused link per user/purpose, and index expiry for
-- cleanup jobs.
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS email_hash text;

-- Older verification links were not address-bound; retire them so a changed
-- address cannot be verified by a link issued for a previous address.
UPDATE auth_tokens
SET used_at = COALESCE(used_at, now())
WHERE purpose = 'email_verification' AND email_hash IS NULL;

-- Keep only the newest unused link per user and purpose before adding the
-- uniqueness constraint.
UPDATE auth_tokens t
SET used_at = now()
FROM (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, purpose
           ORDER BY created_at DESC, id DESC
         ) AS rank
  FROM auth_tokens
  WHERE used_at IS NULL
) ranked
WHERE t.id = ranked.id AND ranked.rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS auth_tokens_one_unused_idx
  ON auth_tokens(user_id, purpose)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS auth_tokens_expiry_idx ON auth_tokens(expires_at);
CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx ON user_sessions(expires_at);
