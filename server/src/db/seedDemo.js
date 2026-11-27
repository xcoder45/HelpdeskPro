import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { pool, withPoolTransaction } from './pool.js';

const MINUTE_MS = 60_000;
const DEMO_EMAIL_SUFFIX = 'helpdesk.local';

const DEMO_USERS = [
  { key: 'employee', email: `demo.employee@${DEMO_EMAIL_SUFFIX}`, first: 'Dana', last: 'Requester', role: 'employee' },
  { key: 'employee2', email: `demo.employee2@${DEMO_EMAIL_SUFFIX}`, first: 'Milo', last: 'Requester', role: 'employee' },
  { key: 'agent', email: `demo.agent@${DEMO_EMAIL_SUFFIX}`, first: 'Alex', last: 'Support', role: 'agent' }
];

// createdMinutesAgo is the age of the ticket at seeding time. The response deadline
// is always derived from the seeded SLA rule: created_at + rule.response_minutes.
// Negative firstResponse/resolved offsets are absolute minutes relative to now.
const DEMO_TICKETS = [
  {
    title: '[DEMO] Laptop will not power on',
    description: 'The laptop has no power indicator and does not start when connected to the dock.',
    category: 'Hardware', subcategory: 'Laptop / Desktop', priority: 'High', status: 'New',
    requester: 'employee', assignee: null, createdMinutesAgo: 285, firstRespondedAtMinutes: null
  },
  {
    title: '[DEMO] VPN connection drops repeatedly',
    description: 'The VPN client disconnects every few minutes while working from home.',
    category: 'Network', subcategory: 'VPN', priority: 'Critical', status: 'In Progress',
    requester: 'employee2', assignee: 'agent', createdMinutesAgo: 80, firstRespondedAtMinutes: -10
  },
  {
    title: '[DEMO] Password reset for shared mailbox',
    description: 'Access to the shared marketing mailbox needs to be restored for the team.',
    category: 'Access & Accounts', subcategory: 'Password Reset', priority: 'Medium', status: 'Resolved',
    requester: 'employee', assignee: 'agent', createdMinutesAgo: 240, firstRespondedAtMinutes: -60,
    resolvedAtMinutes: -30, resolution: 'Password rotated and the mailbox was re-added to the team profile.'
  },
  {
    title: '[DEMO] Printer reports a persistent paper jam',
    description: 'The second floor printer displays a paper jam error after every print job.',
    category: 'Hardware', subcategory: 'Printers', priority: 'Low', status: 'Assigned',
    requester: 'employee2', assignee: 'agent', createdMinutesAgo: 840, firstRespondedAtMinutes: null
  },
  {
    title: '[DEMO] Outlook crashes during startup',
    description: 'Outlook closes immediately after entering credentials on one workstation.',
    category: 'Software', subcategory: 'Applications', priority: 'High', status: 'Pending',
    requester: 'employee', assignee: 'agent', createdMinutesAgo: 250, firstRespondedAtMinutes: -5
  },
  {
    title: '[DEMO] Request for an additional monitor',
    description: 'A second monitor is needed for the designated workstation in the finance area.',
    category: 'Facilities', subcategory: 'Office Equipment', priority: 'Low', status: 'Closed',
    requester: 'employee2', assignee: 'agent', createdMinutesAgo: 240, firstRespondedAtMinutes: -180,
    resolvedAtMinutes: -120, closedAtMinutes: -110,
    resolution: 'Monitor issued from stock and registered against the workstation asset.'
  },
  {
    title: '[DEMO] Wi-Fi unavailable in meeting room B',
    description: 'Devices cannot see or connect to the corporate wireless network in meeting room B.',
    category: 'Network', subcategory: 'Wi-Fi', priority: 'Medium', status: 'New',
    requester: 'employee', assignee: null, createdMinutesAgo: 180, firstRespondedAtMinutes: null
  },
  {
    title: '[DEMO] Access denied to finance shared drive',
    description: 'The finance shared drive returns an access denied message after the latest login.',
    category: 'Access & Accounts', subcategory: 'Permissions', priority: 'Critical', status: 'Resolved',
    requester: 'employee2', assignee: 'agent', createdMinutesAgo: 180, firstRespondedAtMinutes: -150,
    resolvedAtMinutes: -60, resolution: 'Security group membership restored and access verified with the requester.'
  }
];

function fromNow(now, minutes) {
  return minutes === undefined || minutes === null ? null : new Date(now.getTime() + minutes * MINUTE_MS);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

export async function seedDemoData(activePool = pool) {
  if (env.NODE_ENV === 'production' && !env.ALLOW_PRODUCTION_DEMO_DATA) {
    throw new Error('Demo seeding is disabled in production; set ALLOW_PRODUCTION_DEMO_DATA=true only for intentional demo data');
  }
  if (!env.SEED_DEMO_PASSWORD) {
    throw new Error('SEED_DEMO_PASSWORD is required to create demo accounts');
  }

  return withPoolTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('helpdesk-pro-demo-seed'))`);

    const existing = await client.query('SELECT 1 FROM tickets WHERE is_demo LIMIT 1');
    if (existing.rowCount > 0) {
      return { status: 'skipped', reason: 'Demo dataset already present', tickets: 0 };
    }

    const now = new Date();
    const passwordHash = await bcrypt.hash(env.SEED_DEMO_PASSWORD, 12);
    const { rows: roleRows } = await client.query('SELECT id, name FROM roles');
    const roleIds = new Map(roleRows.map((role) => [role.name, role.id]));

    for (const user of DEMO_USERS) {
      const found = await client.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [user.email]);
      if (found.rowCount > 0) continue;
      await client.query(
        `INSERT INTO users (first_name, last_name, email, password_hash, role_id, is_demo)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [user.first, user.last, user.email, passwordHash, roleIds.get(user.role)]
      );
    }

    const emails = DEMO_USERS.map((user) => user.email.toLowerCase());
    const { rows: userRows } = await client.query(
      'SELECT id, lower(email) AS email FROM users WHERE lower(email) = ANY($1::text[])',
      [emails]
    );
    const userIds = new Map(userRows.map((user) => [user.email, user.id]));

    const { rows: categoryRows } = await client.query('SELECT id, name FROM categories');
    const categoryIds = new Map(categoryRows.map((category) => [category.name, category.id]));
    const { rows: subcategoryRows } = await client.query('SELECT id, category_id, name FROM subcategories');
    const subcategoryIds = new Map(
      subcategoryRows.map((subcategory) => [`${subcategory.category_id}:${subcategory.name}`, subcategory.id])
    );
    const { rows: slaRows } = await client.query('SELECT id, priority, response_minutes FROM sla_rules');
    const slaByPriority = new Map(slaRows.map((rule) => [rule.priority, rule]));

    for (const ticket of DEMO_TICKETS) {
      const categoryId = categoryIds.get(ticket.category);
      const subcategoryId = subcategoryIds.get(`${categoryId}:${ticket.subcategory}`);
      const rule = slaByPriority.get(ticket.priority);
      if (!categoryId || !subcategoryId || !rule) {
        throw new Error(`Demo reference data missing for ticket: ${ticket.title}`);
      }

      const requesterId = userIds.get(`demo.${ticket.requester}@${DEMO_EMAIL_SUFFIX}`.toLowerCase());
      const assigneeId = ticket.assignee
        ? userIds.get(`demo.agent@${DEMO_EMAIL_SUFFIX}`.toLowerCase())
        : null;
      if (!requesterId || (ticket.assignee && !assigneeId)) {
        throw new Error(`Demo user missing for ticket: ${ticket.title}`);
      }

      const createdAt = fromNow(now, -ticket.createdMinutesAgo);
      const responseDueAt = addMinutes(createdAt, rule.response_minutes);
      const firstRespondedAt = fromNow(now, ticket.firstRespondedAtMinutes);
      const resolvedAt = fromNow(now, ticket.resolvedAtMinutes);
      const closedAt = fromNow(now, ticket.closedAtMinutes);

      if (firstRespondedAt && firstRespondedAt < createdAt) {
        throw new Error(`Demo response predates ticket creation: ${ticket.title}`);
      }
      if (resolvedAt && firstRespondedAt && resolvedAt < firstRespondedAt) {
        throw new Error(`Demo resolution predates first response: ${ticket.title}`);
      }

      const { rows: inserted } = await client.query(
        `INSERT INTO tickets (
           title, description, category_id, subcategory_id, priority, status,
           requester_id, assignee_id, sla_rule_id, response_due_at,
           first_responded_at, resolved_at, closed_at, resolution_notes,
           created_at, updated_at, is_demo
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $15, true
         ) RETURNING id, ticket_code`,
        [
          ticket.title, ticket.description, categoryId, subcategoryId, ticket.priority,
          ticket.status, requesterId, assigneeId, rule.id, responseDueAt,
          firstRespondedAt, resolvedAt, closedAt, ticket.resolution ?? null, createdAt
        ]
      );
      const ticketRow = inserted[0];

      const requesterCommentAt = addMinutes(createdAt, 5);
      await client.query(
        `INSERT INTO comments (ticket_id, author_id, body, is_internal, created_at, updated_at)
         VALUES ($1, $2, $3, false, $4, $4)`,
        [ticketRow.id, requesterId, `Demo requester note: ${ticket.description}`, requesterCommentAt]
      );

      await client.query(
        `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value, created_at)
         VALUES ($1, $2, 'created', NULL, NULL, 'New', $3)`,
        [ticketRow.id, requesterId, createdAt]
      );

      if (assigneeId) {
        await client.query(
          `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value, created_at)
           VALUES ($1, $2, 'assigned', 'assignee_id', NULL, $3::text, $4)`,
          [ticketRow.id, assigneeId, assigneeId, addMinutes(createdAt, 2)]
        );
        await client.query(
          `INSERT INTO comments (ticket_id, author_id, body, is_internal, created_at, updated_at)
           VALUES ($1, $2, $3, true, $4, $4)`,
          [
            ticketRow.id, assigneeId,
            'Internal demo note: response and resolution verdict recorded for the support queue.',
            firstRespondedAt ?? addMinutes(createdAt, 10)
          ]
        );
      }

      if (firstRespondedAt) {
        await client.query(
          `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value, created_at)
           VALUES ($1, $2, 'agent_responded', NULL, NULL, $3, $4)`,
          [ticketRow.id, assigneeId, firstRespondedAt.toISOString(), firstRespondedAt]
        );
      }

      if (ticket.status === 'Closed' && resolvedAt) {
        await client.query(
          `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value, created_at)
           VALUES ($1, $2, 'status_changed', 'status', 'New', 'Resolved', $3)`,
          [ticketRow.id, assigneeId ?? requesterId, resolvedAt]
        );
        await client.query(
          `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value, created_at)
           VALUES ($1, $2, 'status_changed', 'status', 'Resolved', 'Closed', $3)`,
          [ticketRow.id, assigneeId ?? requesterId, closedAt ?? addMinutes(resolvedAt, 30)]
        );
      } else if (ticket.status !== 'New') {
        const finalStatusAt = closedAt ?? resolvedAt ?? addMinutes(createdAt, 30);
        await client.query(
          `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value, created_at)
           VALUES ($1, $2, 'status_changed', 'status', 'New', $3, $4)`,
          [ticketRow.id, assigneeId ?? requesterId, ticket.status, finalStatusAt]
        );
      }
    }

    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, details)
       VALUES (NULL, 'demo_data_seeded', 'system', $1::jsonb)`,
      [JSON.stringify({ tickets: DEMO_TICKETS.length, labelled: true, deadlinesDerivedFromRules: true })]
    );

    return {
      status: 'seeded',
      tickets: DEMO_TICKETS.length,
      labelled: true,
      deadlinesDerivedFromRules: true
    };
  }, activePool);
}

if (process.argv[1] && /[\\/]seedDemo\.js$/.test(process.argv[1])) {
  seedDemoData()
    .then((summary) => console.log('[seed:demo]', summary))
    .catch((error) => {
      console.error('[seed:demo] failed:', error.message || String(error));
      process.exitCode = 1;
    });
}
