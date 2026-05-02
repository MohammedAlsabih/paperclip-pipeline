import fetch from 'node-fetch';
import { RepoContext, RepoContextSchema, Route, KeyFile } from './schema';

const GITHUB_API = 'https://api.github.com';

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

async function ghFileContent(owner: string, repo: string, filePath: string, token?: string): Promise<string> {
  const data = await ghFetch(`/repos/${owner}/${repo}/contents/${filePath}`, token) as {
    content?: string;
    encoding?: string;
  };
  if (!data.content) return '';
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
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
    const pkg = JSON.parse(packageJson) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
    const deps = { ...pkg.devDependencies, ...pkg.dependencies };
    if ('vitest' in deps) return 'vitest';
    if ('jest' in deps) return 'jest';
    if ('mocha' in deps) return 'mocha';
    if ('jasmine' in deps) return 'jasmine';
  } catch { /* ignore */ }
  return 'unknown';
}

function isRelevantFile(path: string, specKeywords: string[]): boolean {
  const lower = path.toLowerCase();
  const always = ['middleware', 'auth', 'route', 'router', 'app.ts', 'app.js', 'server.ts', 'server.js', 'index.ts', 'main.ts'];
  if (always.some(k => lower.includes(k))) return true;
  return specKeywords.some(k => lower.includes(k.toLowerCase()));
}

export async function extractRepoContext(options: {
  repoUrl: string;
  branch?: string;
  fileHints?: string[];
  githubToken?: string;
}): Promise<RepoContext> {
  const { repoUrl, fileHints = [], githubToken } = options;
  const token = githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

  const { owner, repo } = parseOwnerRepo(repoUrl);

  // API call 1: repo metadata + default branch
  const repoData = await ghFetch(`/repos/${owner}/${repo}`, token) as {
    default_branch: string;
  };
  const defaultBranch = options.branch ?? repoData.default_branch;

  // API call 2: recursive file tree
  const treeData = await ghFetch(
    `/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
    token
  ) as { tree: Array<{ path: string; type: string }> };

  const allFiles = treeData.tree
    .filter(f => f.type === 'blob' && !SKIP_PATTERNS.some(p => p.test(f.path)))
    .map(f => f.path);

  // Top 50 by relevance
  const specKeywords = [...fileHints, 'route', 'controller', 'handler', 'middleware', 'auth'];
  const ranked = [
    ...allFiles.filter(f => isRelevantFile(f, specKeywords)),
    ...allFiles.filter(f => !isRelevantFile(f, specKeywords)),
  ].slice(0, 50);

  // API call 3: batch-fetch key files
  // Fetch package.json + up to 9 relevant source files
  const toFetch = [
    'package.json',
    ...ranked.filter(f => f !== 'package.json' && /\.(ts|js)$/.test(f)).slice(0, 9),
  ].filter((f, i, arr) => arr.indexOf(f) === i);

  const fetchedContents = await Promise.all(
    toFetch.map(async filePath => {
      try {
        const content = await ghFileContent(owner, repo, filePath, token);
        return { path: filePath, content };
      } catch {
        return { path: filePath, content: '' };
      }
    })
  );

  const contentMap = new Map(fetchedContents.map(f => [f.path, f.content]));

  // Detect test framework from package.json
  const pkgContent = contentMap.get('package.json') ?? '';
  const testFramework = detectTestFramework(pkgContent);

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

  // Build key_files — relevant source files with content (limit 200 LOC each for token budget)
  const keyFiles: KeyFile[] = fetchedContents
    .filter(f => f.path !== 'package.json' && f.content)
    .map(f => ({
      path: f.path,
      content: f.content.split('\n').slice(0, 200).join('\n'),
    }));

  return RepoContextSchema.parse({
    repo_url: repoUrl,
    owner,
    repo,
    default_branch: defaultBranch,
    file_tree: ranked,
    existing_routes: existingRoutes,
    auth_pattern: authPattern,
    test_framework: testFramework,
    key_files: keyFiles,
  });
}
