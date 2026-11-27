import { z } from 'zod';
import { paginationQuerySchema, positiveIdSchema } from '../../validation/common.js';

const prioritySchema = z.enum(['Low', 'Medium', 'High', 'Critical']);
const dateOnly = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1 || year > 9999) return false;
    const parsed = new Date(Date.UTC(year, month - 1, day));
    parsed.setUTCFullYear(year);
    return parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day;
  }, 'must be a valid calendar date');

export const updateSlaRuleSchema = z.object({
  responseMinutes: z.number().int().min(1).max(10_080).optional(),
  isActive: z.boolean().optional()
}).strict().refine(
  (data) => data.responseMinutes !== undefined || data.isActive !== undefined,
  { message: 'provide at least one field to update' }
);

export const slaRuleParamSchema = z.object({ id: positiveIdSchema });

export const slaReportQuerySchema = paginationQuerySchema.extend({
  priority: prioritySchema.optional(),
  slaStatus: z.enum(['met', 'breached', 'pending', 'unverified']).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  sort: z.enum(['createdAt', 'ticketCode', 'priority', 'responseDueAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc')
}).refine(
  (data) => !data.from || !data.to || data.from <= data.to,
  { path: ['to'], message: 'must be on or after from' }
);
