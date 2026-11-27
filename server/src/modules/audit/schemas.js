import { z } from 'zod';
import { paginationQuerySchema, positiveIdSchema } from '../../validation/common.js';

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'must be a valid date');

export const listAuditLogsQuerySchema = paginationQuerySchema.extend({
  actorId: positiveIdSchema.optional(),
  action: z.string().trim().max(100).optional(),
  entityType: z.string().trim().max(50).optional(),
  entityId: positiveIdSchema.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  sort: z.enum(['createdAt', 'action', 'entityType']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc')
}).refine(
  (query) => !query.from || !query.to || Date.parse(query.from) <= Date.parse(query.to),
  { path: ['from'], message: 'must not be after to' }
);
