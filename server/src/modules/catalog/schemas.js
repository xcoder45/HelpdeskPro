import { z } from 'zod';
import { paginationQuerySchema, positiveIdSchema } from '../../validation/common.js';

const nameSchema = z.string().trim().min(2, 'must be at least 2 characters').max(100);
const descriptionSchema = z.string().trim().max(500);

export const listCategoriesQuerySchema = paginationQuerySchema.extend({
  includeInactive: z.enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? false : value === 'true')),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(['name', 'createdAt']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc')
});

export const createCategorySchema = z.object({
  name: nameSchema,
  description: descriptionSchema.default('')
});

export const updateCategorySchema = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  isActive: z.boolean().optional()
}).refine((data) => Object.keys(data).length > 0, {
  message: 'at least one field must be provided'
});

export const subcategoryParamSchema = z.object({
  id: positiveIdSchema,
  subId: positiveIdSchema
});

export const createSubcategorySchema = z.object({
  name: nameSchema
});

export const updateSubcategorySchema = z.object({
  name: nameSchema.optional(),
  isActive: z.boolean().optional()
}).refine((data) => Object.keys(data).length > 0, {
  message: 'at least one field must be provided'
});
