import { z } from 'zod';

export const CreatedFileSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const ModifiedFileSchema = z.object({
  path: z.string(),
  original_content: z.string(),
  new_content: z.string(),
  patch: z.string(),
});

export const CodegenOutputSchema = z.object({
  files_created: z.array(CreatedFileSchema),
  files_modified: z.array(ModifiedFileSchema),
});

export type CreatedFile = z.infer<typeof CreatedFileSchema>;
export type ModifiedFile = z.infer<typeof ModifiedFileSchema>;
export type CodegenOutput = z.infer<typeof CodegenOutputSchema>;
