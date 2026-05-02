import { z } from 'zod';

export const FileToCreateSchema = z.object({
  path: z.string(),
  purpose: z.string(),
});

export const FileToModifySchema = z.object({
  path: z.string(),
  change: z.string(),
  line_hint: z.number().int().optional().nullable(),
});

export const InterfaceFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  optional: z.boolean().default(false),
});

export const InterfaceSchema = z.object({
  name: z.string(),
  fields: z.array(InterfaceFieldSchema),
});

export const ImplementationPlanSchema = z.object({
  summary: z.string(),
  files_to_create: z.array(FileToCreateSchema),
  files_to_modify: z.array(FileToModifySchema),
  interfaces: z.array(InterfaceSchema).default([]),
  test_cases: z.array(z.string()).default([]),
});

export type FileToCreate = z.infer<typeof FileToCreateSchema>;
export type FileToModify = z.infer<typeof FileToModifySchema>;
export type Interface = z.infer<typeof InterfaceSchema>;
export type ImplementationPlan = z.infer<typeof ImplementationPlanSchema>;
