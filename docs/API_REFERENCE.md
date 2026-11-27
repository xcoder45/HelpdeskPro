# API reference

Base URL: `/api`

All responses use a consistent envelope:

```json
{ "success": true, "data": { }, "meta": { "page": 1, "limit": 20, "total": 0, "totalPages": 1 } }
```

Errors use:

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Validation failed", "details": [] } }
```

Paginated endpoints accept `page` (default `1`) and `limit` (default `20`, max `100`) and return `meta`.

## Authentication and CSRF

Authentication uses two cookies:

| Cookie | Flags | Purpose |
|---|---|---|
| `access_token` | httpOnly, SameSite=Strict, Secure in production | JWT session (`HS256`) with `sub`, `ver`, and `jti` |
| `csrf_token` | SameSite=Strict, Secure in production, readable by JS | Double-submit CSRF token |

Unsafe methods require `x-csrf-token` to match the `csrf_token` cookie exactly. Public clients should call `GET /api/auth/csrf` first.

```bat
curl.exe -c cookies.txt http://127.0.0.1:5173/api/auth/csrf
curl.exe -b cookies.txt -c cookies.txt -H "Content-Type: application/json" -H "x-csrf-token: <token from cookies.txt>" -d "{\"email\":\"admin@helpdesk.local\",\"password\":\"ChangeMe123!\"}" http://127.0.0.1:5173/api/auth/login
```

The frontend handles this automatically.

## Status codes

| Code | Meaning |
|---|---|
| 200 / 201 | Success |
| 400 | Validation failure or invalid input |
| 401 | Missing, invalid, expired, revoked, or inactive session |
| 403 | Wrong role, CSRF failure, or non-owner attachment action |
| 404 | Unknown endpoint or hidden foreign record |
| 409 | Duplicate value or invalid reference |
| 413 | Payload too large |
| 422 | Business rule violation, e.g. illegal transition |
| 429 | Rate limit exceeded |
| 500 | Unexpected server error |

## Public endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Database connectivity check; returns `{success:true,data:{status:'ok',database:'ok'}}` |
| GET | `/auth/csrf` | Returns the current CSRF token |
| POST | `/auth/register` | Creates an employee account; returns `{user,csrfToken,requiresVerification}` and sets cookies when verification is not required |
| POST | `/auth/login` | Authenticates; returns `{user,csrfToken}` and creates a tracked session |
| POST | `/auth/password-reset/request` | Generic acceptance response; emails a single-use link when the account exists |
| POST | `/auth/password-reset/confirm` | `{token,password,confirmPassword}`; revokes all sessions and increments `token_version` |
| POST | `/auth/verification/resend` | Generic acceptance response; emails a fresh verification link |
| POST | `/auth/verification/confirm` | `{token}`; marks the address verified |

Registration body:

```json
{
  "firstName": "Jamie",
  "lastName": "Newcomer",
  "email": "jamie@example.com",
  "password": "ChangeMe123!",
  "confirmPassword": "ChangeMe123!"
}
```

Password policy: 10–128 characters, upper case, lower case, digit, and special character.

Login, registration, and lifecycle endpoints are limited to 20 requests per 15 minutes per IP. With `REDIS_URL` configured, limits are shared through Redis in a store isolated from ticket-writer limits; otherwise an in-memory store is used. Rate limiting is disabled when `NODE_ENV=test`.

Reset and verification links use opaque 64-character tokens, are hashed at rest, expire according to `PASSWORD_RESET_TTL`/`EMAIL_VERIFICATION_TTL`, and are single-use. Verification tokens are bound to the email address hash; resending a link or changing the address invalidates older unused verification tokens. Public endpoints return the same response whether or not an account matches the submitted address.

## Current user

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/auth/me` | Any authenticated user | Returns `{user}` |
| GET | `/users/me` | Any authenticated user | Returns `{user}` |
| PATCH | `/users/me` | Any authenticated user | Updates first/last name or email; an email change clears verification and invalidates outstanding verification links |

### Sessions

| Method | Path | Description |
|---|---|---|
| GET | `/auth/sessions` | Lists sessions with `id`, `createdAt`, `expiresAt`, `lastUsedAt`, `ipAddress`, `userAgent`, `revoked`, and `current` |
| DELETE | `/auth/sessions/:sessionId` | Revokes one session; `404` if it is already revoked or belongs to another user. Expired but unrevoked sessions can still be revoked |
| DELETE | `/auth/sessions` | Revokes all other sessions and returns `{revoked}` |
| POST | `/auth/logout` | Revokes the current session only and clears cookies |

## Users — admin

| Method | Path | Description |
|---|---|---|
| GET | `/users` | List users; filters `search`, `role`, `isActive`, `sort`, `order` |
| POST | `/users` | Create a user; body `{firstName,lastName,email,password,role}` |
| GET | `/users/:id` | Get one user; `404` if missing |
| PATCH | `/users/:id` | Update fields; self role change or self deactivation returns `422` |

## Categories and subcategories

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/categories` | Auth | Employee/agent: active catalog; admin: paginated list |
| GET | `/categories/admin` | Admin | Admin list with `includeInactive`, `search`, `sort`, `order` |
| GET | `/categories/:id` | Auth | Admin sees inactive; others receive `404` for inactive |
| POST | `/categories` | Admin | Create category `{name,description?}` |
| PATCH | `/categories/:id` | Admin | Update `{name?,description?,isActive?}` |
| DELETE | `/categories/:id` | Admin | Soft-deactivate; no physical delete |
| POST | `/categories/:id/subcategories` | Admin | Create `{name}` |
| PATCH | `/categories/:id/subcategories/:subId` | Admin | Update `{name?,isActive?}` |

## Tickets

All ticket routes require `employee`, `agent`, or `admin`. Staff-only routes require `agent` or `admin`.

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/tickets/summary` | All | Counts: `total`, `open`, `unassigned`, `resolved`, `closed`, `overdue` |
| GET | `/tickets/assignees` | Staff | Active agents/admins for assignment |
| GET | `/tickets` | All | Filters `status`, `priority`, `search`, `assigneeId`, `requesterId`, `categoryId`, `sort`, `order` |
| POST | `/tickets` | Employee | Create `{title,description,categoryId,subcategoryId?,priority}` |
| GET | `/tickets/:id` | All | Full detail; internal data hidden from requester |
| PATCH | `/tickets/:id` | Employee | Edit `{title,description}` on open tickets |
| POST | `/tickets/:id/cancel` | Employee | Cancel an open ticket |
| POST | `/tickets/:id/reopen` | Employee | Reopen a resolved/closed ticket |
| GET | `/tickets/:id/comments` | All | Paginated comments; internal notes hidden from requester |
| GET | `/tickets/:id/history` | All | Paginated history; optional `action` filter |
| POST | `/tickets/:id/comments` | All | Employee `{body}`; staff `{body,isInternal}` |
| POST | `/tickets/:id/close` | Employee | Confirm resolution on a resolved ticket |
| PATCH | `/tickets/:id/assign` | Staff | `{assigneeId:null\|number,note?}`; `null` unassigns |
| PATCH | `/tickets/:id/status` | Staff | `{status,resolutionNotes?}`; notes required for `Resolved` |
| PATCH | `/tickets/:id/priority` | Staff | `{priority}`; recalculates SLA when applicable |

Allowed statuses: `New`, `Assigned`, `In Progress`, `Pending`, `Resolved`, `Closed`. Allowed priorities: `Low`, `Medium`, `High`, `Critical`.

Ticket writes are limited to 30 requests per minute per user and are disabled in tests.

## Attachments

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/tickets/:id/attachments` | Auth | Paginated metadata; internal attachments hidden from requester |
| POST | `/tickets/:id/attachments` | Auth | Multipart `file`, max 5 MiB, one file |
| GET | `/tickets/:id/attachments/:attachmentId/download` | Auth | Stream download with original filename |
| DELETE | `/tickets/:id/attachments/:attachmentId` | Auth | Employees may delete only their own uploads |
| GET | `/attachments/:id/download` | Auth | Alias that authorizes through the attachment’s ticket |

## SLA

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/sla/rules` | Admin | Response rules by priority |
| PATCH | `/sla/rules/:id` | Admin | `{responseMinutes?:1..10080,isActive?}`; last active rule cannot be disabled |
| GET | `/sla/report` | Staff | Filters `priority`, `slaStatus`, `from`, `to`; returns summary and tickets |

SLA statuses: `met`, `breached`, `pending`, `unverified`.

## Analytics — admin

| Method | Path | Description |
|---|---|---|
| GET | `/dashboard/overview` | Combined summary, priority, category, trends, workload, resolution time |
| GET | `/dashboard/summary` | Ticket totals |
| GET | `/dashboard/priority` | Counts by priority |
| GET | `/dashboard/category` | Counts by category |
| GET | `/dashboard/weekly-trends` | Created/resolved by week |
| GET | `/dashboard/agent-workload` | Open/assigned/completed per agent |
| GET | `/dashboard/average-resolution-time` | Resolution average |

`overview` and `weekly-trends` accept `weeks=1..52`, default `8`. Every value is computed from the database.

## Audit log — admin

`GET /api/audit-logs` supports `actorId`, `action`, `entityType`, `entityId`, `from`, `to`, `sort`, and `order`. Records are append-only.

Recorded actions include `auth.register`, `auth.login_success`, `auth.login_failed`, `auth.logout`, `user.created`, `user.updated`, `user.updated_self`, ticket lifecycle events, comment events, category changes, and `sla.rule_updated`.

## Notifications

Delivery is best-effort after the database commit. Events include registration, ticket creation, assignment, replies, status changes, resolution, closure, cancellation, and reopening. Internal notes and priority changes do not send mail. If SMTP is not configured, delivery is skipped and logged; the API request still succeeds.
