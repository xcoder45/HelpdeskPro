# Testing report

Final verification was run on 2026-11-28 after Phase 10 production hardening, account lifecycle, frontend routing, Playwright E2E work, two all-phase bug/security reviews, and Render single-container startup initialization. [Phase 10 status](STATUS.md) records the delivered scope and residual risks.

## Commands

From the project root:

```bat
cmd /c npm test
cmd /c npm run e2e
cmd /c npm run build
cmd /c npm audit --audit-level=high
docker compose config --quiet
docker compose -f docker-compose.yml -f docker-compose.prod.yml config --quiet
```

The E2E command uses local Chrome. Set `E2E_BASE_URL` to test another running instance.

## Final results

| Check | Result |
|---|---|
| Server tests | **28 files passed, 180 tests passed** |
| Web tests | **5 files passed, 137 tests passed** |
| Playwright E2E | **4 tests passed, 0 failed** |
| `npm run build` | Passed |
| `npm audit --audit-level=high` | `found 0 vulnerabilities` |
| Base `docker compose config --quiet` | Exit code `0` |
| Production override `docker compose config --quiet` | Exit code `0` |

Build output:

```text
dist/index.html                           0.53 kB │ gzip:   0.31 kB
dist/assets/index-*.css                  16.04 kB │ gzip:   4.05 kB
dist/assets/StaffApp-*.js                45.03 kB │ gzip:  10.18 kB
dist/assets/index-*.js                  269.78 kB │ gzip:  81.92 kB
dist/assets/AnalyticsPanel-*.js         457.88 kB │ gzip: 128.51 kB
✓ built in 1.44s
```

Recharts is no longer in the initial entry chunk: `AnalyticsPanel-*.js` is loaded only when the admin opens Analytics, and `StaffApp-*.js` is loaded after staff sign-in.

Vitest emits two harmless `Not implemented: navigation to another Document` messages from jsdom, and the server run prints an optional worker-reuse performance hint. Neither indicates a failed test.

## Test architecture

### Server tests

Run with Vitest and Supertest against `TEST_DATABASE_URL`. Vitest refuses to run if the test database is the same as `DATABASE_URL`; use a separate database.

Coverage includes all Phase 1–9 areas plus:

- `auth.register` verification notification, optional enforcement, verified backfill, and verified-by-default when enforcement is off.
- Session listing, single-session revocation, sign-out elsewhere, current-session logout isolation, and `last_used_at` refresh.
- Generic password-reset requests, single-use confirmation, replay rejection, session revocation, and audit events.
- Email verification confirm/resend, single-use behavior, one unused token per purpose, email binding, and invalidation after resend or email change.
- Redis rate-limit store adapter command forwarding, no-config fallback, isolated auth/ticket default stores, and resilient in-memory fallback.
- Retention job parameterization, expired lifecycle-row cleanup, `purge_expired_activity()` behavior, and retention `EXECUTE` privilege.
- Append-only least privilege: migrations 011/012, rejection of the GUC bypass by a non-retention role, and an actual aged-row purge.
- Least-privileged API role provisioning, including rejection of unsafe role names and removal of `DELETE` on append-only tables.
- Production rejection of placeholder application database passwords and validation that quarantine stays outside `UPLOAD_DIR`.
- Atomic lifecycle audits: password-reset, verification, and session-revocation records are written in the same transaction as the state change.
- Session-revocation audit records for single-session and sign-out-elsewhere actions.
- Staff recipients are notified when a requester replies; the recipient query no longer generates an invalid `falser` predicate.
- Attachment quota enforcement, fail-closed AV rejection with quarantine, and Office/text MIME spoofing rejection, including generic-ZIP/OLE2 spoofing and required Office part checks.
- New migration/schema expectations for 009 through 012.
- Startup initialization ordering and failure behavior: migrations precede reference seeding, bootstrap users are excluded, Express is not created or listened on failure, and the pool is closed before exit.

### Web tests

Run with Vitest, Testing Library, and jsdom. The API module is mocked for component tests; `api.test.js` exercises the real fetch wrapper with a stubbed global `fetch`.

Coverage includes all Phase 1–9 areas plus:

- Route parsing for employee, staff, and lifecycle paths.
- Browser history navigation, token extraction from verification/reset links, and stale ticket-detail replacement.
- Returning to a requested staff deep link after sign-in, including role-safe redirects for admin-only views.
- Password reset request/confirm screens and verification confirm/resend screens while signed in.
- Active-session dialog listing, both revocation actions, expired-session labels, Escape handling, and focus capture.
- Global forwarding of attachment `401`/`403` failures, preservation of the original 403 reason, and a lazy-chunk error boundary with an in-page retry as well as a full reload.

`web/src/test/setup.js` adds jest-dom matchers, stubs `ResizeObserver`/`getBoundingClientRect`, resets browser history between tests, and warms the lazy chart chunk so first-navigation assertions are deterministic.

### Browser E2E

Playwright runs against `http://127.0.0.1:5173` with local Chrome and starts the root dev stack when no server is already listening.

| Flow | Result |
|---|---|
| Unauthenticated `/tickets/42` redirects to `/login` | Passed |
| Employee login, sessions dialog, logout | Passed |
| Generic password-reset confirmation | Passed |
| Admin `/staff/analytics` deep link after sign-in | Passed |

The analytics E2E checks the database-backed accessible tables, not hard-coded figures.

## Live verification

The following were checked against the running local stack, not only mocks:

| Check | Result |
|---|---|
| `GET /api/auth/csrf` through Vite proxy | `200` |
| Employee, agent, admin, and demo employee UI logins | Correct workspace loaded |
| API login smoke for seeded accounts | All passed with correct roles |
| Logout replay | `401` |
| Admin Categories, Audit, and Analytics panels | Loaded real database records |
| Static frontend root | `200` |
| Backend health endpoint | `200` |
| Dashboard figures | PostgreSQL returned `total=11, open=7, resolved=2, overdue=3`; the analytics UI showed the same values |
| `/tickets/42`, `/staff/analytics`, `/reset-password`, `/verify-email` | Deep links rendered correctly; a missing ticket showed `Ticket not found` and returned to the dashboard |
| Signed-in lifecycle links | `/reset-password?token=...` rendered the confirmation form; `/verify-email?token=...` rendered the verification result |
| Sessions dialog | Listed current and other sessions with sign-in, expiry, and last-used times |
| Local migrations 007–012 | Applied |

No SMTP verification was performed because no SMTP credentials are configured locally; lifecycle emails are validated through notification-event tests and generic API responses.

## Screenshots

Nine real screenshots from the running application remain in `docs/screenshots/`. They cover sign-in, employee portal, new ticket, staff queue, admin analytics/users/categories/audit, and SLA management.

## Not covered

- No SMTP delivery, penetration test, load test, Redis failover, or ClamAV malware-sample test was performed.
- The production compose was validated with `docker compose config`; the full container stack was not started locally.
- Rate limiting is skipped under `NODE_ENV=test`; Redis command forwarding is covered by an injected-client unit test.
