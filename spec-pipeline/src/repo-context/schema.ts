import { z } from 'zod';

export const RouteSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL']),
  path: z.string(),
  file: z.string(),
});

export const KeyFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  summary: z.string().optional(),
});

export const RepoContextSchema = z.object({
  repo_url: z.string(),
  owner: z.string(),
  repo: z.string(),
  default_branch: z.string(),
  file_tree: z.array(z.string()),
  existing_routes: z.array(RouteSchema),
  auth_pattern: z.enum(['jwt', 'session', 'api-key', 'basic', 'none', 'unknown']),
  test_framework: z.enum(['jest', 'mocha', 'vitest', 'jasmine', 'unknown']),
  key_files: z.array(KeyFileSchema),
});

export type Route = z.infer<typeof RouteSchema>;
export type KeyFile = z.infer<typeof KeyFileSchema>;
export type RepoContext = z.infer<typeof RepoContextSchema>;
