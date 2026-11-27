import { withTransaction } from '../../db/transaction.js';
import { recordAudit } from '../../services/audit.js';
import { badRequest, notFoundError, unprocessable } from '../../utils/errors.js';
import { TICKET_SELECT } from '../tickets/service.js';
import { SLA_STATUS_SQL } from './calculations.js';

export function formatSlaRule(row) {
  return {
    id: Number(row.id),
    priority: row.priority,
    responseMinutes: Number(row.response_minutes),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listSlaRules(database) {
  const { rows } = await database.query(
    `SELECT * FROM sla_rules
     ORDER BY CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 ELSE 4 END`
  );
  return rows.map(formatSlaRule);
}

export async function updateSlaRule(database, ruleId, actor, { responseMinutes, isActive }, ipAddress = null) {
  return withTransaction(database, async (client) => {
    const { rows } = await client.query('SELECT * FROM sla_rules WHERE id = $1 FOR UPDATE', [ruleId]);
    if (rows.length === 0) throw notFoundError('SLA rule not found');

    const current = rows[0];
    const nextResponseMinutes = responseMinutes ?? Number(current.response_minutes);
    const nextIsActive = isActive ?? Boolean(current.is_active);
    if (nextResponseMinutes === Number(current.response_minutes) && nextIsActive === Boolean(current.is_active)) {
      throw badRequest('SLA rule is already set to those values');
    }

    if (Boolean(current.is_active) && !nextIsActive) {
      const { rows: activeRules } = await client.query(
        'SELECT count(*)::int AS active_count FROM sla_rules WHERE priority = $1 AND is_active = true',
        [current.priority]
      );
      if (Number(activeRules[0].active_count) <= 1) {
        throw unprocessable('Each priority must keep at least one active SLA rule');
      }
    }

    await client.query(
      `UPDATE sla_rules SET response_minutes = $2, is_active = $3 WHERE id = $1`,
      [ruleId, nextResponseMinutes, nextIsActive]
    );

    await recordAudit(client, {
      actorId: actor.id,
      action: 'sla.rule_updated',
      entityType: 'sla_rule',
      entityId: ruleId,
      details: {
        priority: current.priority,
        from: { responseMinutes: Number(current.response_minutes), isActive: Boolean(current.is_active) },
        to: { responseMinutes: nextResponseMinutes, isActive: nextIsActive }
      },
      ipAddress
    });

    const { rows: updated } = await client.query('SELECT * FROM sla_rules WHERE id = $1', [ruleId]);
    return formatSlaRule(updated[0]);
  });
}

function reportFilters(query) {
  const values = [];
  const conditions = [];
  const addValue = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (query.priority) conditions.push(`t.priority = ${addValue(query.priority)}`);
  if (query.slaStatus) conditions.push(`${SLA_STATUS_SQL} = ${addValue(query.slaStatus)}`);
  if (query.from) conditions.push(`t.created_at >= ${addValue(`${query.from}T00:00:00.000Z`)}::timestamptz`);
  if (query.to) conditions.push(`t.created_at < (${addValue(`${query.to}T00:00:00.000Z`)}::timestamptz + interval '1 day')`);

  return { where: conditions.length ? conditions.join(' AND ') : 'true', values };
}

export async function getSlaReport(database, query) {
  const { where, values } = reportFilters(query);

  return withTransaction(database, async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');

    const { rows: summaryRows } = await client.query(
      `SELECT
         count(*)::int AS total_tickets,
         count(*) FILTER (WHERE t.first_responded_at IS NOT NULL)::int AS responded,
         count(*) FILTER (WHERE ${SLA_STATUS_SQL} = 'met')::int AS met_response,
         count(*) FILTER (WHERE ${SLA_STATUS_SQL} = 'breached')::int AS breached,
         count(*) FILTER (WHERE ${SLA_STATUS_SQL} = 'pending')::int AS pending_response,
         count(*) FILTER (WHERE ${SLA_STATUS_SQL} = 'unverified')::int AS unverified_response,
         ROUND(AVG(EXTRACT(EPOCH FROM (t.first_responded_at - t.created_at)) / 60))::int AS average_response_minutes
       FROM tickets t
       WHERE ${where}`,
      values
    );

    const summaryRow = summaryRows[0];
    const metResponse = Number(summaryRow.met_response ?? 0);
    const responded = Number(summaryRow.responded ?? 0);
    const summary = {
      totalTickets: Number(summaryRow.total_tickets ?? 0),
      responded,
      metResponse,
      breached: Number(summaryRow.breached ?? 0),
      pendingResponse: Number(summaryRow.pending_response ?? 0),
      unverifiedResponse: Number(summaryRow.unverified_response ?? 0),
      complianceRate: responded === 0 ? 0 : Math.round((metResponse / responded) * 100),
      averageResponseMinutes: Number(summaryRow.average_response_minutes ?? 0)
    };

    const offset = (query.page - 1) * query.limit;
    const rowValues = [...values, query.limit, offset];
    const sortColumns = {
      createdAt: 'q.created_at',
      ticketCode: 'q.ticket_code',
      priority: 'q.priority',
      responseDueAt: 'q.response_due_at'
    };
    const direction = query.order === 'asc' ? 'ASC' : 'DESC';
    const { rows } = await client.query(
      `SELECT q.*
       FROM (
         ${TICKET_SELECT}
         WHERE ${where}
       ) q
       ORDER BY ${sortColumns[query.sort]} ${direction} NULLS LAST, q.id DESC
       LIMIT $${rowValues.length - 1} OFFSET $${rowValues.length}`,
      rowValues
    );

    const tickets = rows.map((row) => ({
      id: Number(row.id),
      ticketCode: row.ticket_code,
      title: row.title,
      priority: row.priority,
      status: row.status,
      requesterName: row.requester_name ?? null,
      assigneeName: row.assignee_name ?? null,
      responseDueAt: row.response_due_at,
      firstRespondedAt: row.first_responded_at,
      resolvedAt: row.resolved_at,
      slaStatus: row.sla_status ?? null,
      timeRemainingMinutes: row.sla_time_remaining_minutes === null
        ? null
        : Number(row.sla_time_remaining_minutes),
      responseMinutes: row.sla_response_minutes === null ? null : Number(row.sla_response_minutes),
      resolutionMinutes: row.sla_resolution_minutes === null ? null : Number(row.sla_resolution_minutes),
      metResponse: row.sla_status === 'met',
      isDemo: Boolean(row.is_demo),
      isOverdue: Boolean(row.is_overdue),
      createdAt: row.created_at
    }));

    return { summary, tickets, total: summary.totalTickets };
  });
}
