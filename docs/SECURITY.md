# Security notes

This document describes controls implemented through Phase 10 and the risks that remain explicit operational or product decisions. It is not a production security sign-off.

## Implemented controls

### Authentication and sessions

- Passwords are hashed with bcrypt cost 12.
- Login uses a timing-equalising dummy hash for unknown accounts.
- Sessions are JWTs signed with `HS256`; other algorithms are rejected.
- Tokens carry `sub`, `ver`, and `jti`. `ver` is compared with `users.token_version`, and `jti` must match an unrevoked `user_sessions` row.
- Production startup rejects short, example, and obvious placeholder JWT secrets.
- Logout revokes only the current session. Password reset revokes every session and increments `token_version`.
- Users can list sessions, revoke one session, or revoke all other sessions.
- Password-reset and verification links use 64-character opaque tokens, are stored only as SHA-256 hashes, expire, and are single-use. Verification tokens are bound to an email hash; a newer request or an email change invalidates older unused links.
- Public lifecycle endpoints return the same generic response whether or not an account matches the submitted address.
- Email verification is available and can be enforced with `REQUIRE_EMAIL_VERIFICATION`; existing users were backfilled as verified.
- Disabled users cannot authenticate, and the auth middleware rechecks the user and session against the database on every request.
- Cookies are `httpOnly`, `SameSite=Strict`, scoped to `/`, and `Secure` in production.

### CSRF

- `GET /api/auth/csrf` issues a 32-byte random token in a readable cookie.
- Every unsafe request must send the same value in `x-csrf-token`.
- Comparison uses `timingSafeEqual`.
- Login, registration, and lifecycle endpoints also require CSRF; clients must bootstrap from a safe endpoint first.
- The frontend adopts rotated tokens and retries once after refreshing a stale token.

### Authorization

- Fixed roles: `employee`, `agent`, `admin`.
- Employees are scoped to their own tickets in list, detail, comments, history, and attachment operations.
- Internal notes and internal-note history are filtered from employee responses.
- Staff-only and admin-only endpoints use role middleware.
- Users cannot change their own role or disable their own account.
- Foreign ticket IDs return `404` rather than revealing existence.
- Attachment deletion is owner-checked for employees.

### Input validation and error handling

- Zod schemas validate bodies, params, and query strings.
- Password policy requires length 10–128 plus upper case, lower case, digit, and special character.
- JSON bodies are limited to 100 KB; individual attachments are limited to 5 MiB with MIME/extension checks.
- Aggregate ticket and user attachment quotas are checked inside the ticket transaction before files are written.
- ClamAV `INSTREAM` scanning is fail-closed when enabled; rejected uploads are not persisted and are quarantined under `AV_QUARANTINE_DIR`.
- Declared MIME types are checked against file bytes, including Office and text formats, so a spoofed content type cannot bypass validation.
- Malformed JSON maps to `400 INVALID_JSON`; oversized bodies to `413`.
- PostgreSQL errors are translated: duplicate `409`, bad reference `409`, check violation `422`, invalid input `400`.
- 404 responses deliberately omit the requested URL to avoid reflecting tokens or PII.
- Production error logs include only message and code.

### Rate limiting

- Authentication and lifecycle routes: 20 requests per 15 minutes per IP.
- Ticket writes: 30 requests per minute per authenticated user.
- With `REDIS_URL`, limits are shared through `rate-limit-redis` using isolated auth and ticket key prefixes/stores; otherwise an in-memory store is used. A Redis command failure falls back to a per-store in-memory limiter.
- Both return `429 TOO_MANY_REQUESTS` with standard headers.
- Both are disabled in `NODE_ENV=test`.

### Audit, retention, and data integrity

- Registration, login success/failure, logout, session revocation, password lifecycle, verification, user changes, ticket lifecycle events, comment events, category changes, and SLA rule edits are recorded.
- `ticket_history` and `audit_logs` are append-only via database triggers during normal application writes.
- `purge_expired_activity()` uses a transaction-local bypass so retention can remove aged rows without weakening ordinary write protection. The retention job also deletes expired `user_sessions` and `auth_tokens` rows, and migration 010 grants the migration/maintenance role `EXECUTE` on the function.
- Migration checksums prevent silent changes to applied schema files.
- Production bootstrap users and demo data are guarded by separate explicit flags.
- Startup migrations are opt-in and applied before the listener opens; startup fails rather than serving against a partially migrated schema.

## Residual risks and operational decisions

| Risk | Impact | Current mitigation |
|---|---|---|
| `TRUST_PROXY_HOPS` is optional and operator-supplied | Wrong `req.ip` behind proxies weakens IP limits and audit accuracy | Documented in deployment guide; production compose defaults to one hop |
| Double-submit CSRF is not session-bound | A subdomain or XSS-capable context with cookie write access could influence requests | `SameSite=Strict`, no CORS, no user-generated HTML |
| dotenv searches parent directories | An unrelated parent `.env` could leak values into the process | Documented; use clean deployment directories |
| 403 and CSRF denials are not fully audited | Some authorization failures lack audit records | 401 failed logins and successful privileged actions are recorded; UI forwards 403s globally |
| Failed-login audit details include the submitted email | PII in append-only audit log | Access to audit log is admin-only |
| Public self-registration remains enabled | Anyone can create an employee account | Email verification can be enforced; disable the route for invite-only deployments |
| Email verification defaults to off | Unverified accounts can sign in unless explicitly configured | Set `REQUIRE_EMAIL_VERIFICATION=true` for real deployments |
| SMTP delivery is synchronous and best-effort | No queue, retry, or delivery receipt | Notification failures are logged and do not block requests |
| Local-disk attachments | Replicas need shared persistent storage | Named volume in supplied compose; mount shared storage for scale-out |
| Single Redis/ClamAV services | Failures or capacity limits affect limiter/AV behavior | In-memory rate-limit fallback; fail-closed AV; use managed/HA services for production |
| Privileged PostgreSQL roles can bypass append-only triggers | Direct database writes by a superuser/table owner can alter history or audit rows | The API connects as a non-owner role with no `DELETE` on append-only tables; production compose provisions it via `npm run db:provision`. Only the non-login `helpdesk_retention` owner and superusers can purge |
| AV-quarantined files have no automatic retention policy | Rejected files accumulate on disk | Stored outside `UPLOAD_DIR` (validated at startup); operators should monitor and purge `AV_QUARANTINE_DIR` |
| Small crash window can leave orphaned attachment files | Storage leak after interrupted upload | Transaction-ordered writes and cleanup; deletion cleanup failures warn rather than roll back |
| No account lockout beyond IP rate limit | Distributed brute force remains possible | Password policy, shared rate limits, session tracking |
| No CORS layer | Cross-origin API clients are unsupported by design | Same-origin SPA/proxy |
| SLA priority uniqueness is broader than "one active rule" | `sla_rules.priority` has a DB `UNIQUE` constraint, so an inactive rule still reserves its priority | `UNIQUE` prevents duplicates even with direct DB writes; admin UI enforces one active rule |
| No penetration test or load test was performed | Unknown resilience under adversarial or high-volume conditions | Automated unit, integration, and browser E2E coverage only |

## Safe deployment guidance

- Deploy behind HTTPS and set `TRUST_PROXY_HOPS` correctly.
- Keep the API and SPA same-origin.
- Do not expose `csrf_token` to third-party scripts.
- Set a unique `JWT_SECRET`, `APP_BASE_URL`, Redis password, and database password; production Compose fails validation when `REDIS_PASSWORD`, `APP_DATABASE_PASSWORD`, or `APP_BASE_URL` is unset, and the server rejects placeholder secrets.
- Enable email verification and ClamAV for real deployments.
- Restrict filesystem access to `UPLOAD_DIR` and `AV_QUARANTINE_DIR`.
- Back up and monitor PostgreSQL, Redis, and uploads.
- Review the residual-risk table before any real-world rollout.
