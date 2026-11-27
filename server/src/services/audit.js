export async function recordAudit(database, {
  actorId = null,
  action,
  entityType,
  entityId = null,
  details = {},
  ipAddress = null
}) {
  await database.query(
    `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, details, ip_address)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [actorId, action, entityType, entityId, JSON.stringify(details), ipAddress]
  );
}
