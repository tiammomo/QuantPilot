import { z } from 'zod';

export const envVarWriteSchema = z.object({
  key: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128),
  value: z.string().max(1_000_000),
  scope: z.enum(['runtime', 'build', 'both']).default('runtime'),
  varType: z.enum(['string', 'number', 'boolean', 'json']).default('string'),
  isSecret: z.boolean().default(true),
  description: z.string().trim().max(2_000).nullable().optional(),
}).strict();

export const envVarValueUpdateSchema = z.object({
  value: z.string().max(1_000_000),
}).strict();
