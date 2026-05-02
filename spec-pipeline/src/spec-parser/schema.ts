import { z } from 'zod';

export const TechConstraintsSchema = z.object({
  language: z.string().default('typescript'),
  framework: z.string().default('express'),
  auth_pattern: z.enum(['jwt', 'session', 'api-key', 'none']).default('jwt'),
  test_coverage_required: z.boolean().default(true),
});

export const ParsedSpecSchema = z.object({
  feature_description: z.string().min(1, 'feature_description is required'),
  tech_constraints: TechConstraintsSchema,
  acceptance_criteria: z.array(z.string()).default([]),
  file_hints: z.array(z.string()).default([]),
  raw_markdown: z.string(),
});

export type TechConstraints = z.infer<typeof TechConstraintsSchema>;
export type ParsedSpec = z.infer<typeof ParsedSpecSchema>;
