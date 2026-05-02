import { extractRepoContext } from '../repo-context';

// ---------------------------------------------------------------------------
// Mock setup
// node-fetch v2: module.exports = fetch (CommonJS, no .default)
// ---------------------------------------------------------------------------
jest.mock('node-fetch', () => jest.fn());

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockFetch = require('node-fetch') as jest.Mock;

const DEMO_REPO_URL = 'https://github.com/MohammedAlsabih/paperclip-demo-target';
const GH_API = 'https://api.github.com';
const GH_RAW = 'https://raw.githubusercontent.com';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------
function jsonResponse(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

function textResponse(text: string) {
  return { ok: true, status: 200, statusText: 'OK', json: () => Promise.reject(new Error('not JSON')), text: () => Promise.resolve(text) };
}

function notFoundResponse() {
  return { ok: false, status: 404, statusText: 'Not Found', json: () => Promise.resolve({}), text: () => Promise.resolve('') };
}

const MOCK_REPO_META = { default_branch: 'master' };

const MOCK_TREE = {
  tree: [
    { path: 'package.json', type: 'blob' },
    { path: 'src/app.ts', type: 'blob' },
    { path: 'src/middleware/jwt.ts', type: 'blob' },
    { path: 'src/routes/users.ts', type: 'blob' },
    { path: 'src/__tests__/users.test.ts', type: 'blob' },
    { path: 'node_modules/express/index.js', type: 'blob' },  // should be filtered
    { path: 'dist/app.js', type: 'blob' },                    // should be filtered
  ],
};

const MOCK_PACKAGE_JSON = JSON.stringify({
  devDependencies: { jest: '^29.0.0', typescript: '^5.0.0' },
  dependencies: { express: '^4.18.0', jsonwebtoken: '^9.0.0' },
});

const MOCK_JWT_TS = `
import jwt from 'jsonwebtoken';
export function verifyJwt(req, res, next) {
  const token = req.headers.authorization?.slice(7);
  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) return res.status(401).json({ error: 'Invalid token' });
    req.userId = payload.sub;
    next();
  });
}
`;

const MOCK_USERS_TS = `
import { Router } from 'express';
import { verifyJwt } from '../middleware/jwt';
const router = Router();
router.get('/', verifyJwt, (req, res) => res.json([]));
router.get('/:id', verifyJwt, (req, res) => res.json({}));
export default router;
`;

// Routes all fetch() calls based on the URL.
// Longer patterns take priority (sorted by length desc) so 'git/trees' beats '/repos/'.
function routedMock(routes: Record<string, unknown>) {
  const sorted = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return (url: string) => {
    for (const [pattern, response] of sorted) {
      if (url.includes(pattern)) return Promise.resolve(response);
    }
    return Promise.resolve(textResponse(''));
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('extractRepoContext (mocked)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('parses owner and repo from URL', async () => {
    mockFetch.mockImplementation(routedMock({
      [GH_API + '/repos/']: jsonResponse(MOCK_REPO_META),
      [GH_API + '/repos/MohammedAlsabih/paperclip-demo-target/git/trees']: jsonResponse(MOCK_TREE),
    }));
    const ctx = await extractRepoContext({ repoUrl: DEMO_REPO_URL });
    expect(ctx.owner).toBe('MohammedAlsabih');
    expect(ctx.repo).toBe('paperclip-demo-target');
    expect(ctx.default_branch).toBe('master');
  });

  it('filters out node_modules and dist from file_tree', async () => {
    mockFetch.mockImplementation(routedMock({
      [GH_API + '/repos/']: jsonResponse(MOCK_REPO_META),
      [GH_API + '/repos/MohammedAlsabih/paperclip-demo-target/git/trees']: jsonResponse(MOCK_TREE),
    }));
    const ctx = await extractRepoContext({ repoUrl: DEMO_REPO_URL });
    expect(ctx.file_tree).not.toContain('node_modules/express/index.js');
    expect(ctx.file_tree).not.toContain('dist/app.js');
    expect(ctx.file_tree).toContain('src/app.ts');
    expect(ctx.file_tree).toContain('src/middleware/jwt.ts');
  });

  it('detects jest as test framework from package.json', async () => {
    mockFetch.mockImplementation(routedMock({
      [GH_API + '/repos/']: jsonResponse(MOCK_REPO_META),
      [GH_API + '/repos/MohammedAlsabih/paperclip-demo-target/git/trees']: jsonResponse(MOCK_TREE),
      [GH_RAW + '/MohammedAlsabih/paperclip-demo-target/master/package.json']: textResponse(MOCK_PACKAGE_JSON),
    }));
    const ctx = await extractRepoContext({ repoUrl: DEMO_REPO_URL });
    expect(ctx.test_framework).toBe('jest');
  });

  it('detects jwt auth pattern from source files', async () => {
    mockFetch.mockImplementation(routedMock({
      [GH_API + '/repos/']: jsonResponse(MOCK_REPO_META),
      [GH_API + '/repos/MohammedAlsabih/paperclip-demo-target/git/trees']: jsonResponse(MOCK_TREE),
      [GH_RAW + '/MohammedAlsabih/paperclip-demo-target/master/package.json']: textResponse(MOCK_PACKAGE_JSON),
      ['middleware/jwt.ts']: textResponse(MOCK_JWT_TS),
    }));
    const ctx = await extractRepoContext({ repoUrl: DEMO_REPO_URL, fileHints: ['src/middleware/jwt.ts'] });
    expect(ctx.auth_pattern).toBe('jwt');
  });

  it('extracts routes from source files', async () => {
    mockFetch.mockImplementation(routedMock({
      [GH_API + '/repos/']: jsonResponse(MOCK_REPO_META),
      [GH_API + '/repos/MohammedAlsabih/paperclip-demo-target/git/trees']: jsonResponse(MOCK_TREE),
      [GH_RAW + '/MohammedAlsabih/paperclip-demo-target/master/package.json']: textResponse(MOCK_PACKAGE_JSON),
      ['routes/users.ts']: textResponse(MOCK_USERS_TS),
    }));
    const ctx = await extractRepoContext({ repoUrl: DEMO_REPO_URL, fileHints: ['src/routes/users.ts'] });
    const routePaths = ctx.existing_routes.map(r => r.path);
    expect(routePaths).toContain('/');
    expect(routePaths).toContain('/:id');
  });

  it('throws a useful error for non-GitHub URLs', async () => {
    await expect(
      extractRepoContext({ repoUrl: 'https://gitlab.com/foo/bar' })
    ).rejects.toThrow('Cannot parse GitHub URL');
  });

  it('survives individual file fetch failures gracefully', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes(GH_API + '/repos/') && !url.includes('git/trees')) return Promise.resolve(jsonResponse(MOCK_REPO_META));
      if (url.includes('git/trees')) return Promise.resolve(jsonResponse(MOCK_TREE));
      if (url.includes('package.json')) return Promise.resolve(notFoundResponse()); // fails
      return Promise.resolve(textResponse(''));
    });
    const ctx = await extractRepoContext({ repoUrl: DEMO_REPO_URL });
    expect(ctx.repo_url).toBe(DEMO_REPO_URL);
    expect(ctx.test_framework).toBe('unknown');
  });

  it('includes heuristic summaries in key_files when no LLM key is provided', async () => {
    mockFetch.mockImplementation(routedMock({
      [GH_API + '/repos/']: jsonResponse(MOCK_REPO_META),
      [GH_API + '/repos/MohammedAlsabih/paperclip-demo-target/git/trees']: jsonResponse(MOCK_TREE),
      [GH_RAW + '/MohammedAlsabih/paperclip-demo-target/master/package.json']: textResponse(MOCK_PACKAGE_JSON),
      ['middleware/jwt.ts']: textResponse(MOCK_JWT_TS),
    }));
    const ctx = await extractRepoContext({ repoUrl: DEMO_REPO_URL, fileHints: ['src/middleware/jwt.ts'] });
    const jwtFile = ctx.key_files.find(f => f.path.includes('jwt'));
    expect(jwtFile).toBeDefined();
    expect(jwtFile?.summary).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Live integration test — only runs when GITHUB_TOKEN or GH_TOKEN is set
// ---------------------------------------------------------------------------
const RUN_LIVE = Boolean(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN);

(RUN_LIVE ? describe : describe.skip)('extractRepoContext (live — requires GITHUB_TOKEN)', () => {
  jest.setTimeout(30_000);

  it('extracts real context from demo-app repo', async () => {
    jest.unmock('node-fetch');
    const { extractRepoContext: liveExtract } = jest.requireActual('../repo-context') as typeof import('../repo-context');

    const ctx = await liveExtract({
      repoUrl: DEMO_REPO_URL,
      fileHints: ['src/middleware/jwt.ts', 'src/routes/'],
    });

    expect(ctx.owner).toBe('MohammedAlsabih');
    expect(ctx.test_framework).toBe('jest');
    expect(ctx.auth_pattern).toBe('jwt');
    expect(ctx.file_tree).toContain('src/middleware/jwt.ts');
    expect(ctx.existing_routes.some(r => r.file.includes('users'))).toBe(true);
    expect(ctx.key_files.some(f => f.path === 'src/middleware/jwt.ts')).toBe(true);
  });
});
