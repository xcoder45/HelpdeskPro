import { z } from 'zod';

export const emailSchema = z.string()
  .trim()
  .min(3)
  .max(255)
  .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'must be a valid email address');

export const passwordSchema = z.string()
  .min(10, 'must be at least 10 characters')
  .max(128, 'must be at most 128 characters')
  .regex(/[A-Z]/, 'must include an uppercase letter')
  .regex(/[a-z]/, 'must include a lowercase letter')
  .regex(/\d/, 'must include a number')
  .regex(/[^A-Za-z0-9]/, 'must include a special character');

export const positiveIdSchema = z.union([
  z.number().int().positive(),
  z.string().regex(/^\d+$/, 'must be a positive integer').transform(Number)
]).refine((value) => Number.isSafeInteger(value) && value > 0, 'must be a positive integer');

export const idParamSchema = z.object({
  id: positiveIdSchema
});

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});
