# Deployment guide

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js | `>=20.19.0` |
| npm | Workspace support required |
| PostgreSQL | 16 recommended; Docker Compose provides it locally |
| Docker Desktop | Required for the local database and for the production compose stack |
| Redis | Optional locally; recommended for shared production rate limits |
| ClamAV | Required when `AV_ENABLED=true` |
| SMTP | Optional; without it, notification emails are logged as skipped |

On Windows PowerShell, use `cmd /c npm ...` if `npm.ps1` execution is blocked.

## Local development

1. Copy `.env.example` to `.env` and set at least `DATABASE_URL`, `JWT_SECRET`, and the Docker `POSTGRES_*` values.
2. Start PostgreSQL:

   ```bat
   docker compose up -d postgres
   ```

3. Create, migrate, and seed the databases:

   ```bat
   cmd /c npm run db:setup
   cmd /c npm run seed:demo
   ```

4. Start both application processes:

   ```bat
   cmd /c npm run dev
   ```

5. Open <http://127.0.0.1:5173>.

`npm run dev` starts the API (`node --watch --watch-path=src src/server.js`) and the Vite frontend concurrently. The narrowed watch path prevents Vite dependency optimization from restarting the API due to `node_modules` changes. Starting only `npm run dev -w web` will produce proxy `502` responses; start both processes or run the root command.

Vite proxies `/api` to `VITE_API_PROXY_TARGET`, defaulting to `http://127.0.0.1:3000`. Both dev and preview servers use the proxy.

Run the browser test suite with `cmd /c npm run e2e`. It starts the root dev stack if no server is already listening and uses local Chrome; set `E2E_BASE_URL` to test another instance.

## Environment variables

Validated by `server/src/config/env.js`. Invalid configuration fails startup with an aggregated error.

### Required

| Variable | Rules |
|---|---|
| `DATABASE_URL` | `postgres:` or `postgresql:` URL |
| `JWT_SECRET` | At least 16 characters; at least 32 unique non-placeholder characters in production |

### Optional

| Variable | Default / notes |
|---|---|
| `NODE_ENV` | `development`, `test`, or `production`; default `development` |
| `PORT` | Integer 1–65535; default `3000` |
| `TEST_DATABASE_URL` | Required for tests; must be a different database from `DATABASE_URL` |
| `JWT_EXPIRES_IN` | Positive duration such as `1d`, `12h`, `30m`, or seconds; default `1d` |
| `TRUST_PROXY_HOPS` | Non-negative integer; set behind a reverse proxy so `req.ip` is correct |
| `APP_BASE_URL` | Public origin used in reset/verification email links; default `http://localhost:5173` |
| `REQUIRE_EMAIL_VERIFICATION` | Boolean; default `false` |
| `PASSWORD_RESET_TTL` | Reset-link lifetime; default `1h` |
| `EMAIL_VERIFICATION_TTL` | Verification-link lifetime; default `24h` |
| `REDIS_URL` | `redis:`/`rediss:` URL; when absent, rate limits use an in-memory store |
| `RUN_MIGRATIONS_ON_START` | Boolean; default `false` |
| `RETENTION_ENABLED` | Boolean; default `false`; enables the scheduled purge |
| `AUDIT_RETENTION_DAYS` | Minimum 1; default `365` |
| `TICKET_HISTORY_RETENTION_DAYS` | Minimum 1; default `365` |
| `RETENTION_INTERVAL_MS` | Minimum `3600000`; default `86400000` |
| `UPLOAD_DIR` | Local attachment directory; default `./uploads` |
| `MAX_UPLOAD_BYTES` | Per-file cap, 1024–104857600 bytes; default `5242880` (5 MiB). Must not exceed either aggregate quota |
| `TICKET_UPLOAD_QUOTA_BYTES` | Positive integer aggregate ticket quota; default `52428800` (50 MiB) |
| `USER_UPLOAD_QUOTA_BYTES` | Positive integer aggregate user quota; default `104857600` (100 MiB) |
| `AV_ENABLED` | Boolean; default `false`; fail-closed ClamAV scanning when enabled |
| `CLAMAV_HOST` | Required when AV is enabled; production compose sets `clamav` |
| `CLAMAV_PORT` | Integer 1–65535; default `3310` |
| `AV_SCAN_TIMEOUT_MS` | Minimum 100; default `5000` |
| `AV_QUARANTINE_DIR` | Quarantine directory for rejected files; default `./quarantine`. Must be outside `UPLOAD_DIR` |
| `NOTIFICATIONS_ENABLED` | Boolean; default `true` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | SMTP transport; port default `587`, secure default `false` |
| `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Optional mail credentials and sender |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Required by Docker Compose interpolation |
| `APP_DATABASE_USER`, `APP_DATABASE_PASSWORD` | Least-privileged role used by the API; default `helpdesk_app` / `local_dev_change_me`. The password must be unique in production |
| `REDIS_PASSWORD` | Used by the production Redis service; default `local_dev_change_me` for local use |
| `SEED_ADMIN_EMAIL`, `SEED_AGENT_EMAIL`, `SEED_EMPLOYEE_EMAIL` | Bootstrap account emails |
| `SEED_ADMIN_PASSWORD`, `SEED_AGENT_PASSWORD`, `SEED_EMPLOYEE_PASSWORD` | Bootstrap passwords, at least 8 characters |
| `SEED_DEMO_PASSWORD` | Required by `npm run seed:demo`, at least 8 characters |
| `ALLOW_PRODUCTION_BOOTSTRAP_USERS` | Boolean, default `false`; use only for intentional production bootstrap |
| `ALLOW_PRODUCTION_DEMO_DATA` | Boolean, default `false`; separate opt-in for demo accounts/tickets |
| `VITE_API_PROXY_TARGET` | Vite dev/preview proxy target; default `http://127.0.0.1:3000` |
| `VITE_API_BASE_URL` | Browser API prefix baked into the build; default `/api` |

`.env` and `.env.*` files are ignored except `.env.example`. dotenv is searched upward from the working directory, so avoid unrelated parent `.env` files when deploying.

## Production build and start

```bat
cmd /c npm ci
cmd /c npm run build
cmd /c npm start
```

`npm run build` writes `web/dist`. `npm start` runs `server/src/server.js`, which serves both `/api` and the built SPA when `NODE_ENV=production` and `web/dist/index.html` exists. If the built file is absent, static serving is silently skipped.

The server applies migrations before listening only when `RUN_MIGRATIONS_ON_START=true`. Seeds remain manual. On `SIGINT`/`SIGTERM`, the server closes the HTTP listener, retention timer, Redis client, and database pool.

## Production compose stack

```bat
copy .env.example .env
REM Edit .env: replace JWT_SECRET, POSTGRES_PASSWORD, APP_DATABASE_PASSWORD, REDIS_PASSWORD, and APP_BASE_URL, then add SMTP settings.
REM The production override refuses to start if REDIS_PASSWORD, APP_DATABASE_PASSWORD, or APP_BASE_URL is unset.
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

The override builds `Dockerfile.server` and `Dockerfile.web`, then starts a one-shot migration service, the API, nginx, PostgreSQL, Redis, and ClamAV. The migration service connects with the PostgreSQL owner credentials, applies checksummed migrations, then creates and grants the separate `helpdesk_app` role. The API waits for that service to finish and connects only as `helpdesk_app`, which has no `DELETE` privilege on `audit_logs` or `ticket_history` and is not a member of the retention owner role. nginx listens on host port `8080`, accepts uploads up to 6 MiB, proxies `/api` to the Node service, and serves SPA routes with an `index.html` fallback. PostgreSQL, uploads, the AV quarantine directory, and Redis data use named volumes; PostgreSQL is not published to the host.

The API container sets `RUN_MIGRATIONS_ON_START=false`, `RETENTION_ENABLED=true`, `REDIS_URL`, `AV_ENABLED=true`, `AV_QUARANTINE_DIR`, `CLAMAV_HOST=clamav`, and `TRUST_PROXY_HOPS=1`. The Redis healthcheck uses the configured password, and ClamAV has a 360-second startup grace period. Set `APP_BASE_URL` to the public HTTPS origin so lifecycle emails point back to the correct frontend. If the deployment sits behind more than one trusted proxy, override `TRUST_PROXY_HOPS` accordingly.

Validate a deployment configuration without starting containers:

```bat
docker compose config --quiet
docker compose -f docker-compose.yml -f docker-compose.prod.yml config --quiet
```

The supplied compose stack was configuration-validated but not fully started in the local verification environment. Redis and ClamAV are single services; scale them separately or use managed equivalents for high availability.

## Reverse proxy and HTTPS

The application assumes same-origin API access. Static hosting without the Express server must either:

1. Proxy `/api` to the Node backend on the same origin, or
2. Build with `VITE_API_BASE_URL` pointing to a CORS-enabled API.

The current backend has no CORS middleware, so option 1 is strongly preferred.

Because cookies use `Secure` in production, deploy behind HTTPS. Set `TRUST_PROXY_HOPS` to the correct number of trusted proxies; otherwise `req.ip`-based rate limits and audit IPs may record proxy addresses.

Example proxy responsibilities:

- Terminate TLS.
- Forward `Host` and `X-Forwarded-For` according to your trust configuration.
- Serve `/` and SPA routes from the Node process or static files with `index.html` fallback.
- Route `/api` to the Node process.
- Do not cache `/api/*`; the server already sends `Cache-Control: no-store`.

## Database and storage operations

- Migration runs are opt-in at startup with `RUN_MIGRATIONS_ON_START=true`; seeds remain manual.
- `npm run db:create` creates configured databases; `npm run db:setup` creates, migrates, and seeds.
- `npm run migrate` applies pending migrations on demand.
- `npm run db:provision` applies migrations, then creates/updates the least-privileged `APP_DATABASE_USER` role used by the API.
- `npm run retention` runs one aged audit/history purge immediately.
- Never edit an already applied migration; checksums are enforced.
- Persist and back up PostgreSQL plus `UPLOAD_DIR`. Neither files nor metadata alone are sufficient.
- Use a database role with least privilege; the API does not need superuser rights. Migrations 011 and 012 create a non-login `helpdesk_retention` owner for the append-only tables and purge functions, so migration must run as a role with `CREATEROLE` or superuser rights. `npm run db:provision` applies migrations and grants the API role everything except `DELETE` on `audit_logs` and `ticket_history`; migration 010 grants the maintenance role `EXECUTE` on `purge_expired_activity(integer, integer)`.
- `TEST_DATABASE_URL` must be distinct; Vitest refuses to run against the primary database.

## Notifications, lifecycle, and scanning

Set `SMTP_HOST` and `SMTP_FROM` to enable email delivery. Without both, events are logged as `delivery skipped / not_configured` and requests still succeed. Delivery is synchronous and best-effort; there is no queue, retry, or delivery audit.

Password-reset and verification links use `APP_BASE_URL` and opaque, hashed, single-use tokens. Verification links are bound to the email address; resending a link or changing the address invalidates older unused links. Enable `REQUIRE_EMAIL_VERIFICATION` to block sign-in until the address is verified; when it is off, new registrations and existing users backfilled by migration 007 are verified.

Attachments are capped per file and by aggregate ticket/user quotas, with declared content types checked against file bytes. When `AV_ENABLED=true`, every upload is streamed to ClamAV before it is written; unavailable scanners and detected malware reject the upload and quarantine the bytes under `AV_QUARANTINE_DIR`. Keep `UPLOAD_DIR` and `AV_QUARANTINE_DIR` on persisted, writable storage and purge quarantined files under an operator policy.

## Operational checklist

- [ ] `.env` contains required values, a freshly generated `JWT_SECRET`, and no accidentally inherited parent values
- [ ] PostgreSQL reachable and migrations applied
- [ ] `web/dist/index.html` present for production
- [ ] HTTPS configured before relying on `Secure` cookies
- [ ] `TRUST_PROXY_HOPS` set behind a proxy
- [ ] `APP_BASE_URL` set to the public origin
- [ ] `UPLOAD_DIR` and `AV_QUARANTINE_DIR` persisted and writable
- [ ] Redis configured for shared rate limits in multi-replica deployments
- [ ] ClamAV reachable when `AV_ENABLED=true`
- [ ] Retention schedule and `*_RETENTION_DAYS` reviewed
- [ ] SMTP configured if email notifications are required
- [ ] Bootstrap/demo users disabled unless intentionally seeding
- [ ] Health endpoint checked: `GET /api/health`
- [ ] Backup job covers database and uploads

## Known deployment gaps

The production compose is validated by `docker compose config` but was not started end-to-end locally. It uses single Redis and ClamAV services, local attachment storage, and synchronous SMTP delivery. Those are scaling and availability decisions, not incomplete Phase 10 features.
