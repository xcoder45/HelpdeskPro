import { withTransaction } from '../../db/transaction.js';
import { badRequest, notFoundError, unprocessable } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { SLA_CALCULATION_SELECT } from '../sla/calculations.js';

export const TICKET_SELECT = `
  SELECT t.*,
         c.name AS category_name,
         s.name AS subcategory_name,
         requester.first_name || ' ' || requester.last_name AS requester_name,
         u.first_name || ' ' || u.last_name AS assignee_name,
         (
           t.status NOT IN ('Resolved', 'Closed')
           AND t.first_responded_at IS NULL
           AND t.response_due_at < now()
         ) AS is_overdue,
         ${SLA_CALCULATION_SELECT}
  FROM tickets t
  JOIN categories c ON c.id = t.category_id
  LEFT JOIN subcategories s ON s.id = t.subcategory_id
  JOIN users requester ON requester.id = t.requester_id
  LEFT JOIN users u ON u.id = t.assignee_id
`;

const OPEN_STATUSES = ['New', 'Assigned', 'In Progress', 'Pending'];
const STAFF_ROLES = ['agent', 'admin'];

const STATUS_TRANSITIONS = {
  New: ['Assigned', 'In Progress', 'Pending', 'Resolved'],
  Assigned: ['In Progress', 'Pending', 'Resolved'],
  'In Progress': ['Assigned', 'Pending', 'Resolved'],
  Pending: ['In Progress', 'Resolved'],
  Resolved: ['Closed', 'In Progress', 'Assigned'],
  Closed: []
};

function isStaff(actor) {
  return Boolean(actor && STAFF_ROLES.includes(actor.role));
}

function scopeActor(actor) {
  return isStaff(actor) ? null : Number(actor?.id ?? actor);
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

export function formatTicket(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    ticketCode: row.ticket_code,
    title: row.title,
    description: row.description,
    categoryId: Number(row.category_id),
    categoryName: row.category_name ?? null,
    subcategoryId: nullableNumber(row.subcategory_id),
    subcategoryName: row.subcategory_name ?? null,
    priority: row.priority,
    status: row.status,
    requesterId: Number(row.requester_id),
    requesterName: row.requester_name ?? null,
    assigneeId: nullableNumber(row.assignee_id),
    assigneeName: row.assignee_name ?? null,
    responseDueAt: row.response_due_at,
    firstRespondedAt: row.first_responded_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    resolutionNotes: row.resolution_notes,
    isDemo: Boolean(row.is_demo),
    isOverdue: Boolean(row.is_overdue),
    sla: {
      status: row.sla_status ?? null,
      timeRemainingMinutes: nullableNumber(row.sla_time_remaining_minutes),
      responseMinutes: nullableNumber(row.sla_response_minutes),
      resolutionMinutes: nullableNumber(row.sla_resolution_minutes)
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function formatComment(row) {
  return {
    id: Number(row.id),
    ticketId: Number(row.ticket_id),
    authorId: Number(row.author_id),
    authorName: [row.first_name, row.last_name].filter(Boolean).join(' '),
    authorRole: row.author_role ?? null,
    body: row.body,
    isInternal: Boolean(row.is_internal),
    createdAt: row.created_at
  };
}

function formatHistory(row) {
  return {
    id: Number(row.id),
    action: row.action,
    fieldName: row.field_name,
    oldValue: row.old_value,
    newValue: row.new_value,
    actorName: [row.first_name, row.last_name].filter(Boolean).join(' ') || 'System',
    createdAt: row.created_at
  };
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function commentQuery() {
  return `SELECT c.*, u.first_name, u.last_name, r.name AS author_role
          FROM comments c
          JOIN users u ON u.id = c.author_id
          JOIN roles r ON r.id = u.role_id`;
}

export async function findTicket(database, id, actor) {
  const { rows } = await database.query(
    `${TICKET_SELECT} WHERE t.id = $1 AND ($2::bigint IS NULL OR t.requester_id = $2)`,
    [id, scopeActor(actor)]
  );
  if (rows.length === 0) throw notFoundError('Ticket not found');
  return formatTicket(rows[0]);
}

export async function lockTicket(database, id, actor) {
  const { rows } = await database.query(
    `${TICKET_SELECT}
     WHERE t.id = $1 AND ($2::bigint IS NULL OR t.requester_id = $2)
     FOR UPDATE OF t`,
    [id, scopeActor(actor)]
  );
  if (rows.length === 0) throw notFoundError('Ticket not found');
  return formatTicket(rows[0]);
}

export async function listTickets(database, actor, query) {
  const values = [scopeActor(actor)];
  const conditions = ['($1::bigint IS NULL OR t.requester_id = $1)'];
  const addValue = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (query.status) {
    conditions.push(`t.status = ${addValue(query.status)}`);
  }

  if (query.priority) {
    conditions.push(`t.priority = ${addValue(query.priority)}`);
  }

  if (query.assigneeId === 'unassigned') {
    const openStatuses = addValue(OPEN_STATUSES);
    conditions.push(`t.assignee_id IS NULL AND t.status = ANY(${openStatuses}::text[])`);
  } else if (query.assigneeId !== undefined) {
    conditions.push(`t.assignee_id = ${addValue(query.assigneeId)}`);
  }

  if (query.requesterId !== undefined) {
    conditions.push(`t.requester_id = ${addValue(query.requesterId)}`);
  }

  if (query.categoryId !== undefined) {
    conditions.push(`t.category_id = ${addValue(query.categoryId)}`);
  }

  if (query.search) {
    const parameter = addValue(`%${escapeLike(query.search)}%`);
    conditions.push(`(
      t.ticket_code ILIKE ${parameter} ESCAPE '\\'
      OR t.title ILIKE ${parameter} ESCAPE '\\'
      OR t.description ILIKE ${parameter} ESCAPE '\\'
    )`);
  }

  const where = conditions.join(' AND ');
  const { rows: countRows } = await database.query(
    `SELECT count(*)::int AS total FROM tickets t WHERE ${where}`,
    values
  );

  const sortColumns = {
    createdAt: 't.created_at',
    updatedAt: 't.updated_at',
    title: 't.title',
    responseDueAt: 't.response_due_at'
  };
  const direction = query.order === 'asc' ? 'ASC' : 'DESC';
  const offset = (query.page - 1) * query.limit;
  values.push(query.limit, offset);

  const { rows } = await database.query(
    `${TICKET_SELECT}
     WHERE ${where}
     ORDER BY ${sortColumns[query.sort]} ${direction}, t.id DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );

  return {
    tickets: rows.map(formatTicket),
    total: countRows[0].total
  };
}

export async function getTicketSummary(database, actor) {
  const { rows } = await database.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE status = ANY($2::text[]))::int AS open,
       count(*) FILTER (
         WHERE status = ANY($2::text[]) AND assignee_id IS NULL
       )::int AS unassigned,
       count(*) FILTER (WHERE status = 'Resolved')::int AS resolved,
       count(*) FILTER (WHERE status = 'Closed')::int AS closed,
       count(*) FILTER (
         WHERE first_responded_at IS NULL
           AND response_due_at < now()
           AND status NOT IN ('Resolved', 'Closed')
       )::int AS overdue
     FROM tickets
     WHERE ($1::bigint IS NULL OR requester_id = $1)`,
    [scopeActor(actor), OPEN_STATUSES]
  );
  return rows[0];
}

export async function getTicketDetail(database, id, actor, includeInternal = isStaff(actor)) {
  const ticket = await findTicket(database, id, actor);
  const visibility = includeInternal ? '' : ' AND c.is_internal = false';
  const historyVisibility = includeInternal ? '' : " AND h.action <> 'internal_note_added'";

  const { rows: commentRows } = await database.query(
    `${commentQuery()}
     WHERE c.ticket_id = $1${visibility}
     ORDER BY c.created_at ASC, c.id ASC`,
    [id]
  );

  const { rows: historyRows } = await database.query(
    `SELECT h.*, u.first_name, u.last_name
     FROM ticket_history h
     LEFT JOIN users u ON u.id = h.actor_id
     WHERE h.ticket_id = $1${historyVisibility}
     ORDER BY h.created_at ASC, h.id ASC`,
    [id]
  );

  return {
    ...ticket,
    comments: commentRows.map(formatComment),
    history: historyRows.map(formatHistory)
  };
}

export async function listTicketComments(database, id, actor, query) {
  await findTicket(database, id, actor);
  const visibility = isStaff(actor) ? '' : ' AND c.is_internal = false';
  const direction = query.order === 'asc' ? 'ASC' : 'DESC';
  const offset = (query.page - 1) * query.limit;

  const { rows: countRows } = await database.query(
    `SELECT count(*)::int AS total FROM comments c WHERE c.ticket_id = $1${visibility}`,
    [id]
  );
  const { rows } = await database.query(
    `${commentQuery()}
     WHERE c.ticket_id = $1${visibility}
     ORDER BY c.created_at ${direction}, c.id ${direction}
     LIMIT $2 OFFSET $3`,
    [id, query.limit, offset]
  );
  return { comments: rows.map(formatComment), total: countRows[0].total };
}

export async function listTicketHistory(database, id, actor, query) {
  await findTicket(database, id, actor);
  const visibility = isStaff(actor) ? '' : " AND h.action <> 'internal_note_added'";
  const direction = query.order === 'asc' ? 'ASC' : 'DESC';
  const values = [id];
  const addValue = (value) => {
    values.push(value);
    return `$${values.length}`;
  };
  let actionFilter = '';
  if (query.action) {
    actionFilter = ` AND h.action = ${addValue(query.action)}`;
  }
  const limit = addValue(query.limit);
  const offset = addValue((query.page - 1) * query.limit);

  const { rows: countRows } = await database.query(
    `SELECT count(*)::int AS total FROM ticket_history h WHERE h.ticket_id = $1${visibility}${actionFilter}`,
    values.slice(0, query.action ? 2 : 1)
  );
  const { rows } = await database.query(
    `SELECT h.*, u.first_name, u.last_name
     FROM ticket_history h
     LEFT JOIN users u ON u.id = h.actor_id
     WHERE h.ticket_id = $1${visibility}${actionFilter}
     ORDER BY h.created_at ${direction}, h.id ${direction}
     LIMIT ${limit} OFFSET ${offset}`,
    values
  );
  return { history: rows.map(formatHistory), total: countRows[0].total };
}

export async function createTicket(database, requesterId, input, ipAddress = null) {
  return withTransaction(database, async (client) => {
    const { rows: ruleRows } = await client.query(
      'SELECT id, response_minutes FROM sla_rules WHERE priority = $1 AND is_active = true',
      [input.priority]
    );
    if (ruleRows.length === 0) throw badRequest('No active SLA rule for that priority');
    const slaRuleId = ruleRows[0].id;

    const { rowCount: categoryCount } = await client.query(
      'SELECT 1 FROM categories WHERE id = $1 AND is_active = true',
      [input.categoryId]
    );
    if (categoryCount === 0) throw badRequest('Selected category is not available');

    if (input.subcategoryId !== null) {
      const { rowCount: subcategoryCount } = await client.query(
        `SELECT 1 FROM subcategories
         WHERE id = $1 AND category_id = $2 AND is_active = true`,
        [input.subcategoryId, input.categoryId]
      );
      if (subcategoryCount === 0) {
        throw badRequest('Selected subcategory does not belong to the chosen category');
      }
    }

    const createdAt = new Date();
    const responseDueAt = new Date(createdAt.getTime() + ruleRows[0].response_minutes * 60_000);
    const inserted = await client.query(
      `INSERT INTO tickets (
         title, description, category_id, subcategory_id, priority,
         requester_id, sla_rule_id, response_due_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       RETURNING id`,
      [
        input.title,
        input.description,
        input.categoryId,
        input.subcategoryId,
        input.priority,
        requesterId,
        slaRuleId,
        responseDueAt,
        createdAt
      ]
    );
    const ticketId = inserted.rows[0].id;

    await client.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, new_value)
       VALUES ($1, $2, 'created', 'status', 'New')`,
      [ticketId, requesterId]
    );

    await recordAudit(client, {
      actorId: requesterId,
      action: 'ticket.created',
      entityType: 'ticket',
      entityId: ticketId,
      details: { priority: input.priority, categoryId: input.categoryId },
      ipAddress
    });

    return findTicket(client, ticketId, { id: requesterId, role: 'employee' });
  });
}

export async function addTicketComment(database, ticketId, actor, body, ipAddress = null) {
  return withTransaction(database, async (client) => {
    const ticket = await lockTicket(client, ticketId, actor);
    if (ticket.status === 'Closed') {
      throw unprocessable('Closed tickets do not accept new comments');
    }

    const inserted = await client.query(
      `INSERT INTO comments (ticket_id, author_id, body, is_internal)
       VALUES ($1, $2, $3, false) RETURNING id`,
      [ticketId, actor.id, body]
    );

    await client.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, new_value)
       VALUES ($1, $2, 'comment_added', $3::text)`,
      [ticketId, actor.id, String(inserted.rows[0].id)]
    );

    await recordAudit(client, {
      actorId: actor.id,
      action: 'ticket.commented',
      entityType: 'ticket',
      entityId: ticketId,
      details: { commentId: Number(inserted.rows[0].id) },
      ipAddress
    });

    const { rows } = await client.query(
      `${commentQuery()} WHERE c.id = $1`,
      [inserted.rows[0].id]
    );
    return formatComment(rows[0]);
  });
}

export async function closeTicket(database, ticketId, actor, ipAddress = null) {
  return withTransaction(database, async (client) => {
    const ticket = await lockTicket(client, ticketId, actor);
    if (ticket.status !== 'Resolved') {
      throw unprocessable('Only resolved tickets can be closed by the requester');
    }

    await client.query(
      `UPDATE tickets SET status = 'Closed', closed_at = now() WHERE id = $1`,
      [ticketId]
    );

    await client.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value)
       VALUES ($1, $2, 'status_changed', 'status', 'Resolved', 'Closed')`,
      [ticketId, actor.id]
    );

    await recordAudit(client, {
      actorId: actor.id,
      action: 'ticket.closed',
      entityType: 'ticket',
      entityId: ticketId,
      details: { previousStatus: 'Resolved' },
      ipAddress
    });

    return getTicketDetail(client, ticketId, actor);
  });
}

export async function editOwnTicket(database, ticketId, actor, { title, description }, ipAddress = null) {
  return withTransaction(database, async (client) => {
    const ticket = await lockTicket(client, ticketId, actor);
    if (!OPEN_STATUSES.includes(ticket.status)) {
      throw unprocessable('Only open tickets can be edited by the requester');
    }

    await client.query(
      `UPDATE tickets SET title = $2, description = $3 WHERE id = $1`,
      [ticketId, title, description]
    );

    await client.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value)
       VALUES ($1, $2, 'ticket_edited', 'details', $3::text, $4::text)`,
      [
        ticketId,
        actor.id,
        JSON.stringify({ title: ticket.title, description: ticket.description }),
        JSON.stringify({ title, description })
      ]
    );

    await recordAudit(client, {
      actorId: actor.id,
      action: 'ticket.requester_edited',
      entityType: 'ticket',
      entityId: ticketId,
      details: { from: { title: ticket.title }, to: { title } },
      ipAddress
    });

    return getTicketDetail(client, ticketId, actor);
  });
}

export async function cancelOwnTicket(database, ticketId, actor, ipAddress = null) {
  return withTransaction(database, async (client) => {
    const ticket = await lockTicket(client, ticketId, actor);
    if (!OPEN_STATUSES.includes(ticket.status)) {
      throw unprocessable('Only open tickets can be cancelled');
    }
    const notes = 'Cancelled by requester';

    await client.query(
      `UPDATE tickets
       SET status = 'Closed', resolved_at = now(), closed_at = now(),
           resolution_notes = $2, cancelled_at = now()
       WHERE id = $1`,
      [ticketId, notes]
    );

    await client.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value)
       VALUES ($1, $2, 'cancelled', 'status', $3, 'Closed')`,
      [ticketId, actor.id, ticket.status]
    );

    await client.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value)
       VALUES ($1, $2, 'status_changed', 'status', $3, 'Closed')`,
      [ticketId, actor.id, ticket.status]
    );

    await client.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value)
       VALUES ($1, $2, 'resolution_notes_changed', 'resolution_notes', $3, $4)`,
      [ticketId, actor.id, ticket.resolutionNotes, notes]
    );

    await recordAudit(client, {
      actorId: actor.id,
      action: 'ticket.cancelled',
      entityType: 'ticket',
      entityId: ticketId,
      details: { from: ticket.status, to: 'Closed', fromNotes: ticket.resolutionNotes, toNotes: notes },
      ipAddress
    });

    return getTicketDetail(client, ticketId, actor);
  });
}

export async function reopenOwnTicket(database, ticketId, actor, ipAddress = null) {
  return withTransaction(database, async (client) => {
    const ticket = await lockTicket(client, ticketId, actor);
    if (!['Resolved', 'Closed'].includes(ticket.status)) {
      throw unprocessable('Only resolved or closed tickets can be reopened by the requester');
    }
    const nextStatus = ticket.assigneeId ? 'In Progress' : 'New';

    await client.query(
      `UPDATE tickets
       SET status = $2, resolved_at = NULL, closed_at = NULL,
           resolution_notes = NULL, cancelled_at = NULL
       WHERE id = $1`,
      [ticketId, nextStatus]
    );

    await client.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value)
       VALUES ($1, $2, 'status_changed', 'status', $3, $4)`,
      [ticketId, actor.id, ticket.status, nextStatus]
    );

    await client.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value)
       VALUES ($1, $2, 'reopened', 'status', $3, $4)`,
      [ticketId, actor.id, ticket.status, nextStatus]
    );

    await client.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value)
       VALUES ($1, $2, 'resolution_notes_changed', 'resolution_notes', $3, NULL)`,
      [ticketId, actor.id, ticket.resolutionNotes]
    );

    await recordAudit(client, {
      actorId: actor.id,
      action: 'ticket.reopened',
      entityType: 'ticket',
      entityId: ticketId,
      details: { from: ticket.status, to: nextStatus, fromNotes: ticket.resolutionNotes, toNotes: null },
      ipAddress
    });

    return getTicketDetail(client, ticketId, actor);
  });
}

export async function getTicketRecipients(database, ticket, roles = []) {
  const ids = [];
  if (roles.includes('requester')) ids.push(ticket.requesterId);
  if (roles.includes('assignee') && ticket.assigneeId) ids.push(ticket.assigneeId);

  const predicates = [];
  if (ids.length) predicates.push('u.id = ANY($1::bigint[])');
  if (roles.includes('staff')) predicates.push("r.name IN ('agent', 'admin')");
  const where = predicates.length ? predicates.join(' OR ') : 'false';
  const { rows } = await database.query(
    `SELECT u.id, u.email, u.first_name, u.last_name, r.name AS role
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.is_active = true AND (${where})`,
    ids.length ? [ids] : []
  );
  return rows.map((row) => ({
    email: row.email,
    name: [row.first_name, row.last_name].filter(Boolean).join(' '),
    role: row.role
  }));
}

export async function listAssignableUsers(database) {
  const { rows } = await database.query(
    `SELECT u.id, u.first_name, u.last_name, u.email, r.name AS role
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.is_active = true AND r.name IN ('agent', 'admin')
     ORDER BY r.name ASC, u.first_name ASC, u.last_name ASC`
  );
  return rows.map((row) => ({
    id: Number(row.id),
    name: [row.first_name, row.last_name].filter(Boolean).join(' '),
    email: row.email,
    role: row.role
  }));
}

export async function assignTicket(database, ticketId, actor, { assigneeId, note = null }, ipAddress = null) {
  return withTransaction(database, async (client) => {
    const ticket = await lockTicket(client, ticketId, actor);
    if (ticket.status === 'Closed') {
      throw unprocessable('Closed tickets cannot be reassigned');
    }

    let assigneeName = null;
    if (assigneeId !== null) {
      const { rows } = await client.query(
        `SELECT u.id, u.first_name, u.last_name
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1 AND u.is_active = true AND r.name IN ('agent', 'admin')`,
        [assigneeId]
      );
      if (rows.length === 0) {
        throw badRequest('Assignee must be an active agent or administrator');
      }
      assigneeName = [rows[0].first_name, rows[0].last_name].filter(Boolean).join(' ');
    }

    let nextStatus = ticket.status;
    if (assigneeId !== null && ticket.status === 'New') nextStatus = 'Assigned';
    if (assigneeId === null && ticket.status === 'Assigned') nextStatus = 'New';

    await client.query(
      `UPDATE tickets SET assignee_id = $2, status = $3 WHERE id = $1`,
      [ticketId, assigneeId, nextStatus]
    );

    await client.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value)
       VALUES ($1, $2, 'assigned', 'assignee_id', $3, $4)`,
      [
        ticketId,
        actor.id,
        ticket.assigneeId === null ? null : String(ticket.assigneeId),
        assigneeId === null ? null : String(assigneeId)
      ]
    );

    if (nextStatus !== ticket.status) {
      await client.query(
        `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value)
         VALUES ($1, $2, 'status_changed', 'status', $3, $4)`,
        [ticketId, actor.id, ticket.status, nextStatus]
      );
    }

    await recordAudit(client, {
      actorId: actor.id,
      action: 'ticket.assigned',
      entityType: 'ticket',
      entityId: ticketId,
      details: {
        assigneeId,
        fromAssignee: ticket.assigneeName,
        toAssignee: assigneeName,
        fromStatus: ticket.status,
        toStatus: nextStatus,
        note
      },
      ipAddress
    });

    return getTicketDetail(client, ticketId, actor);
  });
}

export async function updateTicketStatus(database, ticketId, actor, { status, resolutionNotes = null }, ipAddress = null) {
  return withTransaction(database, async (client) => {
    const ticket = await lockTicket(client, ticketId, actor);

    if (ticket.status === 'Closed') {
      throw unprocessable('Closed tickets cannot be changed');
    }
    if (status === ticket.status) {
      throw unprocessable(`Ticket is already ${status}`);
    }
    if (!STATUS_TRANSITIONS[ticket.status].includes(status)) {
      throw unprocessable(`Cannot change status from ${ticket.status} to ${status}`);
    }
    let assigneeId = ticket.assigneeId;
    let autoAssigned = false;
    if (['Assigned', 'In Progress'].includes(status) && !assigneeId) {
      assigneeId = actor.id;
      autoAssigned = true;
    }

    let resolvedAt = ticket.resolvedAt;
    let closedAt = ticket.closedAt;
    let notes = ticket.resolutionNotes;
    const previousNotes = ticket.resolutionNotes;

    if (status === 'Resolved') {
      if (!resolutionNotes) {
        throw unprocessable('Resolution notes are required when resolving a ticket');
      }
      resolvedAt = new Date();
      closedAt = null;
      notes = resolutionNotes;
    } else if (status === 'Closed') {
      if (ticket.status !== 'Resolved') {
        throw unprocessable('Only resolved tickets can be closed');
      }
      closedAt = new Date();
    } else {
      if (['Resolved', 'Closed'].includes(ticket.status)) {
        resolvedAt = null;
        closedAt = null;
        notes = null;
      }
    }

    await client.query(
      `UPDATE tickets
       SET status = $2, assignee_id = $3, resolved_at = $4, closed_at = $5, resolution_notes = $6
       WHERE id = $1`,
      [ticketId, status, assigneeId, resolvedAt, closedAt, notes]
    );

    if (autoAssigned) {
      await client.query(
        `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value)
         VALUES ($1, $2, 'assigned', 'assignee_id', NULL, $3::text)`,
        [ticketId, actor.id, String(assigneeId)]
      );
    }

    await client.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value)
       VALUES ($1, $2, 'status_changed', 'status', $3, $4)`,
      [ticketId, actor.id, ticket.status, status]
    );

    if (notes !== previousNotes) {
      await client.query(
        `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value)
         VALUES ($1, $2, 'resolution_notes_changed', 'resolution_notes', $3, $4)`,
        [ticketId, actor.id, previousNotes, notes]
      );
    }

    await recordAudit(client, {
      actorId: actor.id,
      action: 'ticket.status_changed',
      entityType: 'ticket',
      entityId: ticketId,
      details: {
        from: ticket.status,
        to: status,
        autoAssigned,
        resolutionNotesChanged: notes !== previousNotes,
        ...(notes !== previousNotes ? { fromNotes: previousNotes, toNotes: notes } : {})
      },
      ipAddress
    });

    const ticketDetail = await getTicketDetail(client, ticketId, actor);
    return { ...ticketDetail, autoAssigned };
  });
}

export async function updateTicketPriority(database, ticketId, actor, { priority }, ipAddress = null) {
  return withTransaction(database, async (client) => {
    const ticket = await lockTicket(client, ticketId, actor);
    if (ticket.status === 'Closed') {
      throw unprocessable('Closed tickets cannot be reprioritised');
    }
    if (ticket.priority === priority) {
      throw unprocessable(`Ticket is already ${priority} priority`);
    }

    const { rows } = await client.query(
      'SELECT id, response_minutes FROM sla_rules WHERE priority = $1 AND is_active = true',
      [priority]
    );
    if (rows.length === 0) throw badRequest('No active SLA rule for that priority');

    const canRecalculate = !ticket.firstRespondedAt && !['Resolved', 'Closed'].includes(ticket.status);
    const responseDueAt = canRecalculate
      ? new Date(new Date(ticket.createdAt).getTime() + rows[0].response_minutes * 60_000)
      : ticket.responseDueAt;

    await client.query(
      `UPDATE tickets SET priority = $2, sla_rule_id = $3, response_due_at = $4 WHERE id = $1`,
      [ticketId, priority, rows[0].id, responseDueAt]
    );

    await client.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, field_name, old_value, new_value)
       VALUES ($1, $2, 'priority_changed', 'priority', $3, $4)`,
      [ticketId, actor.id, ticket.priority, priority]
    );

    await recordAudit(client, {
      actorId: actor.id,
      action: 'ticket.priority_changed',
      entityType: 'ticket',
      entityId: ticketId,
      details: { from: ticket.priority, to: priority },
      ipAddress
    });

    return getTicketDetail(client, ticketId, actor);
  });
}

export async function addStaffComment(database, ticketId, actor, { body, isInternal = false }, ipAddress = null) {
  return withTransaction(database, async (client) => {
    const ticket = await lockTicket(client, ticketId, actor);
    if (ticket.status === 'Closed') {
      throw unprocessable('Closed tickets do not accept new comments');
    }

    const inserted = await client.query(
      `INSERT INTO comments (ticket_id, author_id, body, is_internal)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ticketId, actor.id, body, isInternal]
    );

    if (!isInternal && !ticket.firstRespondedAt) {
      await client.query(
        `UPDATE tickets SET first_responded_at = now() WHERE id = $1 AND first_responded_at IS NULL`,
        [ticketId]
      );
    }

    await client.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, action, new_value)
       VALUES ($1, $2, $3, $4::text)`,
      [
        ticketId,
        actor.id,
        isInternal ? 'internal_note_added' : 'comment_added',
        String(inserted.rows[0].id)
      ]
    );

    await recordAudit(client, {
      actorId: actor.id,
      action: isInternal ? 'ticket.internal_note_added' : 'ticket.agent_replied',
      entityType: 'ticket',
      entityId: ticketId,
      details: { commentId: Number(inserted.rows[0].id), isInternal },
      ipAddress
    });

    const { rows } = await client.query(
      `${commentQuery()} WHERE c.id = $1`,
      [inserted.rows[0].id]
    );
    return formatComment(rows[0]);
  });
}
