import { z } from 'zod';
import { paginationQuerySchema, positiveIdSchema } from '../../validation/common.js';

const prioritySchema = z.enum(['Low', 'Medium', 'High', 'Critical']);
const statusSchema = z.enum(['New', 'Assigned', 'In Progress', 'Pending', 'Resolved', 'Closed']);

export const createTicketSchema = z.object({
  title: z.string().trim().min(3, 'must be at least 3 characters').max(200),
  description: z.string().trim().min(10, 'must be at least 10 characters').max(10_000),
  categoryId: positiveIdSchema,
  subcategoryId: positiveIdSchema.nullable().optional().transform(
    (value) => value ?? null
  ),
  priority: prioritySchema
});

export const editOwnTicketSchema = z.object({
  title: z.string().trim().min(3, 'must be at least 3 characters').max(200),
  description: z.string().trim().min(10, 'must be at least 10 characters').max(10_000)
});

export const commentSchema = z.object({
  body: z.string().trim().min(1, 'must not be empty').max(5000),
  isInternal: z.literal(false).optional()
});

export const staffCommentSchema = z.object({
  body: z.string().trim().min(1, 'must not be empty').max(5000),
  isInternal: z.boolean().default(false)
});

export const assignTicketSchema = z.object({
  assigneeId: positiveIdSchema.nullable(),
  note: z.string().trim().max(1000).optional()
});

export const updateTicketStatusSchema = z.object({
  status: statusSchema,
  resolutionNotes: z.string().trim().min(3).max(5000).optional()
}).refine(
  (data) => data.status !== 'Resolved' || Boolean(data.resolutionNotes),
  { path: ['resolutionNotes'], message: 'is required when resolving a ticket' }
).refine(
  (data) => data.status === 'Resolved' || data.resolutionNotes === undefined,
  { path: ['resolutionNotes'], message: 'is only allowed when resolving a ticket' }
);

export const updateTicketPrioritySchema = z.object({
  priority: prioritySchema
});

export const listCommentsQuerySchema = paginationQuerySchema.extend({
  sort: z.enum(['createdAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('asc')
});

export const listHistoryQuerySchema = paginationQuerySchema.extend({
  action: z.string().trim().max(50).optional(),
  sort: z.enum(['createdAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('asc')
});

export const listTicketsQuerySchema = paginationQuerySchema.extend({
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  search: z.string().trim().max(100).optional(),
  assigneeId: z.union([z.literal('unassigned'), positiveIdSchema]).optional(),
  requesterId: positiveIdSchema.optional(),
  categoryId: positiveIdSchema.optional(),
  sort: z.enum(['createdAt', 'updatedAt', 'title', 'responseDueAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc')
});
