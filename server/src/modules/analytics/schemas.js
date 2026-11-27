import { z } from 'zod';

export const weeklyTrendsQuerySchema = z.object({
  weeks: z.string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine((value) => value >= 1 && value <= 52)
    .default('8')
});
