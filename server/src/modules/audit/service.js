function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

export function formatAuditLog(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    actorId: nullableNumber(row.actor_id),
    actorName: row.actor_name ?? null,
    action: row.action,
    entityType: row.entity_type,
    entityId: nullableNumber(row.entity_id),
    details: row.details ?? {},
    ipAddress: row.ip_address ?? null,
    createdAt: row.created_at
  };
}

const AUDIT_SELECT = `
  SELECT a.*,
         u.first_name || ' ' || u.last_name AS actor_name
  FROM audit_logs a
  LEFT JOIN users u ON u.id = a.actor_id
`;

export async function listAuditLogs(database, query) {
  const values = [];
  const conditions = ['1 = 1'];
  const addValue = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (query.actorId !== undefined) {
    conditions.push(`a.actor_id = ${addValue(query.actorId)}`);
  }
  if (query.action) {
    conditions.push(`a.action = ${addValue(query.action)}`);
  }
  if (query.entityType) {
    conditions.push(`a.entity_type = ${addValue(query.entityType)}`);
  }
  if (query.entityId !== undefined) {
    conditions.push(`a.entity_id = ${addValue(query.entityId)}`);
  }
  if (query.from) {
    conditions.push(`a.created_at >= ${addValue(query.from)}::timestamptz`);
  }
  if (query.to) {
    // A date-only bound means the whole named day, not midnight at its start.
    if (/^\d{4}-\d{2}-\d{2}$/.test(query.to)) {
      conditions.push(`a.created_at < (${addValue(query.to)}::date + interval '1 day')`);
    } else {
      conditions.push(`a.created_at <= ${addValue(query.to)}::timestamptz`);
    }
  }

  const where = conditions.join(' AND ');
  const { rows: countRows } = await database.query(
    `SELECT count(*)::int AS total FROM audit_logs a WHERE ${where}`,
    values
  );

  const sortColumns = {
    createdAt: 'a.created_at',
    action: 'a.action',
    entityType: 'a.entity_type'
  };
  const direction = query.order === 'asc' ? 'ASC' : 'DESC';
  const limit = addValue(query.limit);
  const offset = addValue((query.page - 1) * query.limit);

  const { rows } = await database.query(
    `${AUDIT_SELECT}
     WHERE ${where}
     ORDER BY ${sortColumns[query.sort]} ${direction}, a.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
    values
  );

  return { logs: rows.map(formatAuditLog), total: countRows[0].total };
}
