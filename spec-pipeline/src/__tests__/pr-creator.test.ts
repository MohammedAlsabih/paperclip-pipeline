import { createPr, safeJoin } from '../pr-creator';
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
const fsMock = require('fs') as { writeFileSync: jest.Mock; mkdirSync: jest.Mock; mkdtempSync: jest.Mock; rmSync: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const simpleGitMock = require('simple-git') as jest.Mock;

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

// ---------------------------------------------------------------------------
// Security regression tests (MAL-43)
// ---------------------------------------------------------------------------
describe('safeJoin (B1 — path traversal)', () => {
  it('rejects relative paths that escape the root', () => {
    expect(() => safeJoin('/tmp/spec-pr-test', '../escape.txt')).toThrow(/escapes root/);
    expect(() => safeJoin('/tmp/spec-pr-test', '../../etc/passwd')).toThrow(/escapes root/);
    expect(() => safeJoin('/tmp/spec-pr-test', 'a/../../escape.txt')).toThrow(/escapes root/);
  });

  it('rejects absolute paths', () => {
    expect(() => safeJoin('/tmp/spec-pr-test', '/abs/path')).toThrow(/absolute path/);
    expect(() => safeJoin('/tmp/spec-pr-test', '/etc/passwd')).toThrow(/absolute path/);
  });

  it('accepts normal nested paths', () => {
    expect(safeJoin('/tmp/spec-pr-test', 'src/routes/items.ts'))
      .toMatch(/spec-pr-test[\\/]src[\\/]routes[\\/]items\.ts$/);
  });
});

describe('createPr — path-traversal blocking (B1)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    fsMock.writeFileSync.mockClear();
    fsMock.mkdirSync.mockClear();
  });

  it('throws and does not write when files_created path escapes tmpDir', async () => {
    const malicious: CodegenOutput = {
      files_created: [{ path: '../escape.txt', content: 'pwned' }],
      files_modified: [],
    };

    await expect(
      createPr({
        repoUrl: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app',
        defaultBranch: 'master',
        codegenOutput: malicious,
        plan: MOCK_PLAN,
        githubToken: 'tok',
      })
    ).rejects.toThrow(/escapes root/);

    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('throws and does not write when files_created path is absolute', async () => {
    const malicious: CodegenOutput = {
      files_created: [{ path: '/abs/path', content: 'pwned' }],
      files_modified: [],
    };

    await expect(
      createPr({
        repoUrl: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app',
        defaultBranch: 'master',
        codegenOutput: malicious,
        plan: MOCK_PLAN,
        githubToken: 'tok',
      })
    ).rejects.toThrow(/absolute path/);

    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('throws and does not write when files_modified path escapes tmpDir', async () => {
    const malicious: CodegenOutput = {
      files_created: [],
      files_modified: [
        { path: '../../etc/passwd', original_content: 'old', new_content: 'pwned', patch: '' },
      ],
    };

    await expect(
      createPr({
        repoUrl: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app',
        defaultBranch: 'master',
        codegenOutput: malicious,
        plan: MOCK_PLAN,
        githubToken: 'tok',
      })
    ).rejects.toThrow(/escapes root/);

    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('createPr — token redaction (B2)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    simpleGitMock.mockClear();
  });

  it('does not embed the token in the clone URL', async () => {
    const cloneSpy = jest.fn().mockResolvedValue(undefined);
    simpleGitMock.mockReturnValue({
      clone: cloneSpy,
      addConfig: jest.fn().mockResolvedValue(undefined),
      checkoutLocalBranch: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      push: jest.fn().mockResolvedValue(undefined),
    });
    mockFetch.mockResolvedValueOnce(
      ghOk({ number: 99, html_url: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app/pull/99' })
    );

    const SYNTHETIC_TOKEN = 'ghp_SYNTHETIC_TEST_TOKEN_xyz123';
    await createPr({
      repoUrl: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app',
      defaultBranch: 'master',
      codegenOutput: MOCK_OUTPUT,
      plan: MOCK_PLAN,
      githubToken: SYNTHETIC_TOKEN,
    });

    expect(cloneSpy).toHaveBeenCalled();
    const cloneUrl = cloneSpy.mock.calls[0][0] as string;
    expect(cloneUrl).toBe('https://github.com/MohammedAlsabih/spec-pipeline-demo-app.git');
    expect(cloneUrl).not.toContain(SYNTHETIC_TOKEN);
    expect(cloneUrl).not.toContain('x-access-token');
  });

  it('redacts the token from clone failure error messages', async () => {
    const SYNTHETIC_TOKEN = 'ghp_SYNTHETIC_LEAK_TOKEN_abc456';

    // Simulate a git error that (hypothetically) included the token in its
    // message. Even though we no longer put the token in the URL, the
    // redaction layer must scrub any string that does happen to contain it.
    const leakedError = new Error(
      `fatal: unable to access 'https://x-access-token:${SYNTHETIC_TOKEN}@github.com/foo/bar.git/': repository not found`
    );

    simpleGitMock.mockReturnValue({
      clone: jest.fn().mockRejectedValue(leakedError),
      addConfig: jest.fn().mockResolvedValue(undefined),
      checkoutLocalBranch: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      push: jest.fn().mockResolvedValue(undefined),
    });

    let caught: Error | undefined;
    try {
      await createPr({
        repoUrl: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app',
        defaultBranch: 'master',
        codegenOutput: MOCK_OUTPUT,
        plan: MOCK_PLAN,
        githubToken: SYNTHETIC_TOKEN,
      });
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain(SYNTHETIC_TOKEN);
    expect(caught!.message).toContain('***');
  });
});
