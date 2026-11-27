import { z } from 'zod';
import {
  emailSchema,
  paginationQuerySchema,
  passwordSchema
} from '../../validation/common.js';

const nameSchema = z.string().trim().min(1, 'is required').max(100);
const roleSchema = z.enum(['employee', 'agent', 'admin']);

export const createUserSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  role: roleSchema
});

export const updateUserSchema = z.object({
  firstName: nameSchema.optional(),
  lastName: nameSchema.optional(),
  email: emailSchema.optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional()
}).refine((data) => Object.keys(data).length > 0, {
  message: 'at least one field must be provided'
});

export const updateMeSchema = z.object({
  firstName: nameSchema.optional(),
  lastName: nameSchema.optional(),
  email: emailSchema.optional()
}).refine((data) => Object.keys(data).length > 0, {
  message: 'at least one field must be provided'
});

export const listUsersQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  role: roleSchema.optional(),
  isActive: z.enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  sort: z.enum(['createdAt', 'name', 'email', 'role']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc')
});
