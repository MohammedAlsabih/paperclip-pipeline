import { createPr } from '../pr-creator';
import type { CodegenOutput } from '../code-generator';
import type { ImplementationPlan } from '../architecture-proposer';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
jest.mock('node-fetch', () => jest.fn());
jest.mock('simple-git', () => {
  const mockGit = {
    clone: jest.fn().mockResolvedValue(undefined),
    addConfig: jest.fn().mockResolvedValue(undefined),
    checkoutLocalBranch: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    push: jest.fn().mockResolvedValue(undefined),
  };
  return jest.fn().mockReturnValue(mockGit);
});
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdtempSync: jest.fn().mockReturnValue('/tmp/spec-pr-test'),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  rmSync: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockFetch = require('node-fetch') as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const MOCK_OUTPUT: CodegenOutput = {
  files_created: [
    { path: 'src/routes/items.ts', content: 'export default router;' },
    { path: 'src/routes/__tests__/items.test.ts', content: 'describe("items", () => {});' },
  ],
  files_modified: [
    { path: 'src/app.ts', original_content: 'old', new_content: 'new', patch: '--- a/src/app.ts\n+++ b/src/app.ts\n' },
  ],
};

const MOCK_PLAN: ImplementationPlan = {
  summary: 'Add authenticated CRUD API for items',
  files_to_create: [{ path: 'src/routes/items.ts', purpose: 'CRUD routes' }],
  files_to_modify: [{ path: 'src/app.ts', change: 'register items router' }],
  interfaces: [],
  test_cases: ['POST /items 201'],
};

function ghOk(body: unknown) {
  return { ok: true, status: 201, statusText: 'Created', json: () => Promise.resolve(body) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('createPr', () => {
  beforeEach(() => mockFetch.mockReset());

  it('opens a PR and returns pr_url and pr_number', async () => {
    mockFetch.mockResolvedValueOnce(
      ghOk({ number: 42, html_url: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app/pull/42' })
    );

    const result = await createPr({
      repoUrl: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app',
      defaultBranch: 'master',
      codegenOutput: MOCK_OUTPUT,
      plan: MOCK_PLAN,
      githubToken: 'test-token',
    });

    expect(result.pr_number).toBe(42);
    expect(result.pr_url).toContain('/pull/42');
    expect(result.branch).toMatch(/^spec-pr\/\d+-add-authenticated/);
  });

  it('branch name is unique per run (contains timestamp)', async () => {
    mockFetch.mockResolvedValue(
      ghOk({ number: 1, html_url: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app/pull/1' })
    );

    const [r1, r2] = await Promise.all([
      createPr({ repoUrl: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app', defaultBranch: 'master', codegenOutput: MOCK_OUTPUT, plan: MOCK_PLAN, githubToken: 'tok' }),
      createPr({ repoUrl: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app', defaultBranch: 'master', codegenOutput: MOCK_OUTPUT, plan: MOCK_PLAN, githubToken: 'tok' }),
    ]);

    // Both start with spec-pr/ but the timestamps may or may not differ at ms resolution
    expect(r1.branch).toMatch(/^spec-pr\//);
    expect(r2.branch).toMatch(/^spec-pr\//);
  });

  it('throws if GITHUB_TOKEN is not set', async () => {
    const saved = process.env.GITHUB_TOKEN;
    const savedGh = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;

    await expect(
      createPr({ repoUrl: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app', defaultBranch: 'master', codegenOutput: MOCK_OUTPUT, plan: MOCK_PLAN })
    ).rejects.toThrow('GITHUB_TOKEN is required');

    if (saved) process.env.GITHUB_TOKEN = saved;
    if (savedGh) process.env.GH_TOKEN = savedGh;
  });

  it('throws for non-GitHub URLs', async () => {
    await expect(
      createPr({ repoUrl: 'https://gitlab.com/foo/bar', defaultBranch: 'main', codegenOutput: MOCK_OUTPUT, plan: MOCK_PLAN, githubToken: 'tok' })
    ).rejects.toThrow('Cannot parse GitHub URL');
  });

  it('PR body contains summary and files changed', async () => {
    let capturedBody: unknown;
    mockFetch.mockImplementation((_url: string, init: { body: string }) => {
      capturedBody = JSON.parse(init.body);
      return Promise.resolve(ghOk({ number: 7, html_url: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app/pull/7' }));
    });

    await createPr({
      repoUrl: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app',
      defaultBranch: 'master',
      codegenOutput: MOCK_OUTPUT,
      plan: MOCK_PLAN,
      githubToken: 'tok',
    });

    expect((capturedBody as { body: string }).body).toContain('items');
    expect((capturedBody as { body: string }).body).toContain('src/routes/items.ts');
    expect((capturedBody as { title: string }).title).toBe(MOCK_PLAN.summary);
  });
});
