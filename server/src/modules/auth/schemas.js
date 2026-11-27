import { z } from 'zod';
import { emailSchema, passwordSchema } from '../../validation/common.js';

const nameSchema = z.string().trim().min(1, 'is required').max(100);
const tokenSchema = z.string().trim().min(20).max(200);

export const registerSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  confirmPassword: z.string()
}).refine((data) => data.password === data.confirmPassword, {
  path: ['confirmPassword'],
  message: 'passwords do not match'
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'is required').max(128)
});

export const passwordResetRequestSchema = z.object({
  email: emailSchema
});

export const passwordResetConfirmSchema = z.object({
  token: tokenSchema,
  password: passwordSchema,
  confirmPassword: z.string()
}).refine((data) => data.password === data.confirmPassword, {
  path: ['confirmPassword'],
  message: 'passwords do not match'
});

export const verificationRequestSchema = z.object({
  email: emailSchema
});

export const verificationConfirmSchema = z.object({
  token: tokenSchema
});

export const sessionIdSchema = z.object({
  sessionId: z.coerce.number().int().positive()
});
