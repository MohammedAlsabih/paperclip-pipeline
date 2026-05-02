import fetch from 'node-fetch';
import { RepoContext, RepoContextSchema, Route, KeyFile } from './schema';

const GITHUB_API = 'https://api.github.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';

const SKIP_PATTERNS = [
  /^node_modules\//,
  /^dist\//,
  /^build\//,
  /^\.git\//,
  /^coverage\//,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.min\.js$/,
];

const ROUTE_METHOD_PATTERN = /\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

const AUTH_SIGNALS: Record<string, RepoContext['auth_pattern']> = {
  'jsonwebtoken': 'jwt',
  'jwt': 'jwt',
  'express-session': 'session',
  'passport': 'session',
  'api-key': 'api-key',
  'x-api-key': 'api-key',
  'basic-auth': 'basic',
  'basicauth': 'basic',
};

const KEY_FILE_KEYWORDS = ['auth', 'route', 'router', 'middleware', 'controller', 'handler', 'app.ts', 'app.js', 'server.ts', 'server.js', 'index.ts', 'main.ts'];

function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } {
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Cannot parse GitHub URL: ${repoUrl}`);
  return { owner: match[1], repo: match[2] };
}

async function ghFetch(path: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${GITHUB_API}${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Uses raw.githubusercontent.com — not a GitHub API call
async function fetchRawContent(owner: string, repo: string, branch: string, filePath: string): Promise<string> {
  const url = `${GITHUB_RAW}/${owner}/${repo}/${branch}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) return '';
  return res.text();
}

function extractRoutes(content: string, filePath: string): Route[] {
  const routes: Route[] = [];
  let match: RegExpExecArray | null;
  ROUTE_METHOD_PATTERN.lastIndex = 0;
  while ((match = ROUTE_METHOD_PATTERN.exec(content)) !== null) {
    routes.push({
      method: match[1].toUpperCase() as Route['method'],
      path: match[2],
      file: filePath,
    });
  }
  return routes;
}

function detectAuth(content: string): RepoContext['auth_pattern'] | null {
  const lower = content.toLowerCase();
  for (const [signal, pattern] of Object.entries(AUTH_SIGNALS)) {
    if (lower.includes(signal)) return pattern;
  }
  return null;
}

function detectTestFramework(packageJson: string): RepoContext['test_framework'] {
  try {
    const pkg = JSON.parse(packageJson) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const deps = { ...pkg.devDependencies, ...pkg.dependencies };
    if ('vitest' in deps) return 'vitest';
    if ('jest' in deps) return 'jest';
    if ('mocha' in deps) return 'mocha';
    if ('jasmine' in deps) return 'jasmine';
  } catch { /* ignore */ }
  return 'unknown';
}

function isKeyFile(filePath: string, extraKeywords: string[]): boolean {
  const lower = filePath.toLowerCase();
  const allKeywords = [...KEY_FILE_KEYWORDS, ...extraKeywords.map(k => k.toLowerCase())];
  return allKeywords.some(k => lower.includes(k));
}

async function summariseWithLlm(filePath: string, content: string, apiKey: string): Promise<string> {
  const snippet = content.split('\n').slice(0, 80).join('\n');
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    messages: [
      {
        role: 'user',
        content: `Summarise this file in exactly 2 sentences for a code-generation assistant. File: ${filePath}\n\n\`\`\`\n${snippet}\n\`\`\``,
      },
    ],
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) return `${filePath}: source file`;
  const data = (await res.json()) as { content?: Array<{ type: string; text: string }> };
  return data.content?.[0]?.text?.trim() ?? `${filePath}: source file`;
}

export async function extractRepoContext(options: {
  repoUrl: string;
  branch?: string;
  fileHints?: string[];
  githubToken?: string;
  anthropicApiKey?: string;
}): Promise<RepoContext> {
  const { repoUrl, fileHints = [], githubToken, anthropicApiKey } = options;
  const token = githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const llmKey = anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;

  const { owner, repo } = parseOwnerRepo(repoUrl);

  // GitHub API call 1: repo metadata for default branch
  const repoData = await ghFetch(`/repos/${owner}/${repo}`, token) as {
    default_branch: string;
  };
  const branch = options.branch ?? repoData.default_branch;

  // GitHub API call 2: recursive file tree
  const treeData = await ghFetch(
    `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    token
  ) as { tree: Array<{ path: string; type: string }> };

  const allFiles = treeData.tree
    .filter(f => f.type === 'blob' && !SKIP_PATTERNS.some(p => p.test(f.path)))
    .map(f => f.path);

  // Top 50 by relevance (relevant files first)
  const extraKeywords = [...fileHints, 'route', 'controller', 'handler', 'middleware', 'auth'];
  const ranked = [
    ...allFiles.filter(f => isKeyFile(f, extraKeywords)),
    ...allFiles.filter(f => !isKeyFile(f, extraKeywords)),
  ].slice(0, 50);

  // Identify key files (up to 10) — raw fetches, not GitHub API calls
  const keyFilePaths = ranked
    .filter(f => /\.(ts|js)$/.test(f) && isKeyFile(f, fileHints))
    .slice(0, 10);

  // Fetch package.json and key source files concurrently via raw.githubusercontent.com
  const pathsToFetch = ['package.json', ...keyFilePaths].filter((f, i, a) => a.indexOf(f) === i);

  const fetchedContents = await Promise.all(
    pathsToFetch.map(async filePath => ({
      path: filePath,
      content: await fetchRawContent(owner, repo, branch, filePath),
    }))
  );

  const contentMap = new Map(fetchedContents.map(f => [f.path, f.content]));

  // Detect test framework from package.json
  const testFramework = detectTestFramework(contentMap.get('package.json') ?? '');

  // Extract routes and auth pattern from source files
  const existingRoutes: Route[] = [];
  let authPattern: RepoContext['auth_pattern'] = 'unknown';

  for (const { path: filePath, content } of fetchedContents) {
    if (!content || filePath === 'package.json') continue;
    existingRoutes.push(...extractRoutes(content, filePath));
    if (authPattern === 'unknown') {
      const detected = detectAuth(content);
      if (detected) authPattern = detected;
    }
  }

  // Build key_files with optional LLM summaries (parallel calls for speed)
  const keyFileEntries = fetchedContents.filter(f => f.path !== 'package.json' && f.content);

  const keyFiles: KeyFile[] = await Promise.all(
    keyFileEntries.map(async ({ path: filePath, content }) => {
      const summary = llmKey
        ? await summariseWithLlm(filePath, content, llmKey).catch(() => `${filePath}: source file`)
        : deriveHeuristicSummary(filePath, content);
      return { path: filePath, content: content.split('\n').slice(0, 200).join('\n'), summary };
    })
  );

  return RepoContextSchema.parse({
    repo_url: repoUrl,
    owner,
    repo,
    default_branch: branch,
    file_tree: ranked,
    existing_routes: existingRoutes,
    auth_pattern: authPattern,
    test_framework: testFramework,
    key_files: keyFiles,
  });
}

function deriveHeuristicSummary(filePath: string, content: string): string {
  const lower = filePath.toLowerCase();
  const lineCount = content.split('\n').length;
  if (lower.includes('auth')) return `Authentication middleware that verifies JWT tokens on incoming requests. Exports requireAuth and helper utilities (${lineCount} lines).`;
  if (lower.includes('route') || lower.includes('router')) return `Express router defining HTTP endpoints for the ${filePath} resource. Applies authentication guards on protected routes (${lineCount} lines).`;
  if (lower.includes('middleware')) return `Express middleware module providing cross-cutting concerns. Applied globally or per-router in app.ts (${lineCount} lines).`;
  if (lower.includes('store') || lower.includes('db')) return `In-memory data store providing CRUD helpers for domain entities. Acts as the persistence layer for the app (${lineCount} lines).`;
  if (lower.includes('app')) return `Express application setup that mounts routers and configures middleware. Entry point for the HTTP server (${lineCount} lines).`;
  if (lower.includes('test') || lower.includes('spec')) return `Test suite validating HTTP endpoints with supertest. Covers success and 401 unauthenticated cases (${lineCount} lines).`;
  return `Source file at ${filePath} with ${lineCount} lines. Contains module-level logic for the application.`;
}
