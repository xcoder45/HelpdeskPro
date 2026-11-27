import { z } from 'zod';
import { paginationQuerySchema } from '../../validation/common.js';

export const listAttachmentsQuerySchema = paginationQuerySchema.extend({
  sort: z.enum(['createdAt', 'name', 'size']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('asc')
});
