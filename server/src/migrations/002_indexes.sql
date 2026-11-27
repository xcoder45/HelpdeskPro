-- Query-support and integrity indexes.

CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));
CREATE INDEX users_role_active_idx ON users (role_id, is_active);

CREATE INDEX subcategories_category_idx ON subcategories (category_id) WHERE is_active;

CREATE INDEX tickets_status_priority_idx ON tickets (status, priority);
CREATE INDEX tickets_assignee_status_idx ON tickets (assignee_id, status) WHERE assignee_id IS NOT NULL;
CREATE INDEX tickets_requester_created_idx ON tickets (requester_id, created_at DESC);
CREATE INDEX tickets_created_at_idx ON tickets (created_at DESC);
CREATE INDEX tickets_category_idx ON tickets (category_id);
CREATE INDEX tickets_open_sla_idx ON tickets (response_due_at) WHERE resolved_at IS NULL;
CREATE INDEX tickets_demo_idx ON tickets (is_demo) WHERE is_demo;

CREATE INDEX comments_ticket_created_idx ON comments (ticket_id, created_at);
CREATE INDEX ticket_history_ticket_created_idx ON ticket_history (ticket_id, created_at);
CREATE INDEX attachments_ticket_idx ON attachments (ticket_id);
CREATE INDEX attachments_comment_idx ON attachments (comment_id) WHERE comment_id IS NOT NULL;

CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
