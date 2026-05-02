import { generateCode, stripFences, validateWithTsc } from '../code-generator';
import type { ImplementationPlan } from '../architecture-proposer';
import type { RepoContext } from '../repo-context';
import type { ParsedSpec } from '../spec-parser';

// ---------------------------------------------------------------------------
// Mock child_process so validateWithTsc never triggers real tsc retries
// ---------------------------------------------------------------------------
jest.mock('child_process', () => ({ execSync: jest.fn() }));

// Mock fs for validateWithTsc's temp-dir operations (keeps real fs for other uses)
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdtempSync: jest.fn().mockReturnValue('/tmp/codegen-test'),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  rmSync: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock Anthropic SDK
// ---------------------------------------------------------------------------
jest.mock('@anthropic-ai/sdk', () => {
  const mockCreate = jest.fn();
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
    _mockCreate: mockCreate,
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _mockCreate: mockCreate } = require('@anthropic-ai/sdk') as { _mockCreate: jest.Mock };

// Mock child_process so tsc is never invoked for real in unit tests
jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execSync: mockExecSync } = require('child_process') as { execSync: jest.Mock };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const MOCK_PLAN: ImplementationPlan = {
  summary: 'Add authenticated CRUD API for items',
  files_to_create: [
    { path: 'src/routes/items.ts', purpose: 'CRUD route handlers for items' },
    { path: 'src/routes/__tests__/items.test.ts', purpose: 'Jest tests for items routes' },
  ],
  files_to_modify: [
    { path: 'src/app.ts', change: "add `app.use('/items', itemsRouter)` after the users router", line_hint: 10 },
  ],
  interfaces: [
    { name: 'Item', fields: [{ name: 'id', type: 'string', optional: false }, { name: 'name', type: 'string', optional: false }] },
  ],
  test_cases: [
    'POST /items returns 201',
    'DELETE /items/:id returns 204',
    'POST /items returns 401 without auth',
  ],
};

const MOCK_CONTEXT: RepoContext = {
  repo_url: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app',
  owner: 'MohammedAlsabih',
  repo: 'spec-pipeline-demo-app',
  default_branch: 'master',
  file_tree: ['src/app.ts', 'src/middleware/jwt.ts', 'src/routes/users.ts'],
  existing_routes: [{ method: 'GET', path: '/', file: 'src/routes/users.ts' }],
  auth_pattern: 'jwt',
  test_framework: 'jest',
  key_files: [
    {
      path: 'src/app.ts',
      content: "import express from 'express';\nimport usersRouter from './routes/users';\nconst app = express();\napp.use('/users', usersRouter);\nexport default app;",
      summary: 'Express app setup.',
    },
    {
      path: 'src/middleware/jwt.ts',
      content: "export function verifyJwt(req, res, next) { /* jwt verify */ next(); }",
      summary: 'JWT middleware.',
    },
  ],
};

const MOCK_SPEC: ParsedSpec = {
  feature_description: 'Add authenticated CRUD for items',
  tech_constraints: { language: 'typescript', framework: 'express', auth_pattern: 'jwt', test_coverage_required: true },
  acceptance_criteria: ['POST /items 201', 'DELETE /items/:id 204', 'POST /items 401 without auth'],
  file_hints: ['src/middleware/jwt.ts'],
  raw_markdown: '',
};

const ITEMS_ROUTE_TS = `import { Router, Response } from 'express';
import { verifyJwt, AuthenticatedRequest } from '../middleware/jwt';

const router = Router();
const items: Record<string, { id: string; name: string }> = {};

router.get('/', verifyJwt, (_req: AuthenticatedRequest, res: Response) => {
  res.json(Object.values(items));
});

router.post('/', verifyJwt, (req: AuthenticatedRequest, res: Response) => {
  const item = { id: Date.now().toString(), name: req.body.name as string };
  items[item.id] = item;
  res.status(201).json(item);
});

router.delete('/:id', verifyJwt, (req: AuthenticatedRequest, res: Response) => {
  delete items[req.params.id];
  res.sendStatus(204);
});

export default router;`;

const ITEMS_TEST_TS = `import request from 'supertest';
import app from '../../app';
import { signToken } from '../../middleware/jwt';

const auth = { Authorization: \`Bearer \${signToken('u1')}\` };

describe('POST /items', () => {
  it('returns 201 with created item', async () => {
    const res = await request(app).post('/items').set(auth).send({ name: 'Widget' });
    expect(res.status).toBe(201);
  });
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/items').send({ name: 'Widget' });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /items/:id', () => {
  it('returns 204', async () => {
    const create = await request(app).post('/items').set(auth).send({ name: 'x' });
    const res = await request(app).delete(\`/items/\${create.body.id as string}\`).set(auth);
    expect(res.status).toBe(204);
  });
});`;

const MODIFIED_APP_TS = `import express from 'express';
import usersRouter from './routes/users';
import itemsRouter from './routes/items';
const app = express();
app.use('/users', usersRouter);
app.use('/items', itemsRouter);
export default app;`;

function makeLlmResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

function makeTscError(lines: string[]) {
  return Object.assign(new Error('tsc failed'), {
    stdout: Buffer.from(lines.join('\n')),
    stderr: Buffer.from(''),
  });
}

// ---------------------------------------------------------------------------
// stripFences
// ---------------------------------------------------------------------------
describe('stripFences', () => {
  it('returns plain text unchanged', () => {
    expect(stripFences('const x = 1;')).toBe('const x = 1;');
  });

  it('strips typescript code fences', () => {
    expect(stripFences('```typescript\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('strips bare code fences', () => {
    expect(stripFences('```\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('trims surrounding whitespace from plain text', () => {
    expect(stripFences('  hello  ')).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// validateWithTsc
// ---------------------------------------------------------------------------
describe('validateWithTsc', () => {
  beforeEach(() => mockExecSync.mockReset());

  it('returns ok:true when tsc exits cleanly', () => {
    mockExecSync.mockReturnValue('');
    const result = validateWithTsc({
      files_created: [{ path: 'src/items.ts', content: 'export const x = 1;' }],
      files_modified: [],
    });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns ok:false with error message when real TS errors occur', () => {
    mockExecSync.mockImplementation(() => {
      throw makeTscError(["src/items.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'."]);
    });

    const result = validateWithTsc({
      files_created: [{ path: 'src/items.ts', content: 'const x: number = "oops";' }],
      files_modified: [],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('TS2322');
  });

  it('returns ok:true when only module-resolution errors appear (TS2307, TS2304)', () => {
    mockExecSync.mockImplementation(() => {
      throw makeTscError([
        "src/items.ts(1,20): error TS2307: Cannot find module 'express'.",
        "src/items.ts(3,5): error TS2304: Cannot find name 'Router'.",
      ]);
    });

    const result = validateWithTsc({
      files_created: [{ path: 'src/items.ts', content: "import { Router } from 'express';" }],
      files_modified: [],
    });
    expect(result.ok).toBe(true);
  });

  it('validates modified file new_content alongside created files', () => {
    mockExecSync.mockReturnValue('');
    const result = validateWithTsc({
      files_created: [],
      files_modified: [{ path: 'src/app.ts', original_content: 'old', new_content: MODIFIED_APP_TS, patch: '' }],
    });
    expect(result.ok).toBe(true);
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// generateCode
// ---------------------------------------------------------------------------
describe('generateCode', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockExecSync.mockReset();
    mockExecSync.mockReturnValue(''); // tsc passes by default
  });

  it('generates all files_created and files_modified', async () => {
    mockCreate
      .mockResolvedValueOnce(makeLlmResponse(ITEMS_ROUTE_TS))
      .mockResolvedValueOnce(makeLlmResponse(ITEMS_TEST_TS))
      .mockResolvedValueOnce(makeLlmResponse(MODIFIED_APP_TS));

    const output = await generateCode(MOCK_PLAN, MOCK_CONTEXT, MOCK_SPEC, { apiKey: 'test' });

    expect(output.files_created).toHaveLength(2);
    expect(output.files_modified).toHaveLength(1);
    expect(output.files_created[0].path).toBe('src/routes/items.ts');
    expect(output.files_created[1].path).toBe('src/routes/__tests__/items.test.ts');
    expect(output.files_modified[0].path).toBe('src/app.ts');
  });

  it('produces a non-empty unified diff patch for modified files', async () => {
    mockCreate
      .mockResolvedValueOnce(makeLlmResponse(ITEMS_ROUTE_TS))
      .mockResolvedValueOnce(makeLlmResponse(ITEMS_TEST_TS))
      .mockResolvedValueOnce(makeLlmResponse(MODIFIED_APP_TS));

    const output = await generateCode(MOCK_PLAN, MOCK_CONTEXT, MOCK_SPEC, { apiKey: 'test' });
    const mod = output.files_modified[0];

    expect(mod.patch).toContain('--- a/src/app.ts');
    expect(mod.patch).toContain('+++ b/src/app.ts');
    expect(mod.patch).toContain('itemsRouter');
    expect(mod.original_content).toBeTruthy();
    expect(mod.new_content).toBe(MODIFIED_APP_TS);
  });

  it('strips markdown fences from LLM output', async () => {
    const fenced = '```typescript\n' + ITEMS_ROUTE_TS + '\n```';
    mockCreate
      .mockResolvedValueOnce(makeLlmResponse(fenced))
      .mockResolvedValueOnce(makeLlmResponse(ITEMS_TEST_TS))
      .mockResolvedValueOnce(makeLlmResponse(MODIFIED_APP_TS));

    const output = await generateCode(MOCK_PLAN, MOCK_CONTEXT, MOCK_SPEC, { apiKey: 'test' });
    expect(output.files_created[0].content).not.toContain('```');
    expect(output.files_created[0].content).toContain('import { Router');
  });

  it('retries once on tsc validation failure and succeeds on second attempt', async () => {
    // Use a single-file plan to avoid parallel execution ordering issues
    const singleFilePlan: ImplementationPlan = {
      ...MOCK_PLAN,
      files_to_create: [{ path: 'src/routes/items.ts', purpose: 'CRUD route handlers' }],
      files_to_modify: [],
    };

    mockExecSync
      .mockImplementationOnce(() => {
        throw makeTscError(["src/routes/items.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'."]);
      })
      .mockReturnValue('');

    mockCreate
      .mockResolvedValueOnce(makeLlmResponse('const x: number = "bad";'))  // attempt 1
      .mockResolvedValueOnce(makeLlmResponse(ITEMS_ROUTE_TS));              // retry

    const output = await generateCode(singleFilePlan, MOCK_CONTEXT, MOCK_SPEC, { apiKey: 'test' });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(output.files_created[0].content).toContain('import { Router');
  });

  it('returns last-attempt result if both attempts fail tsc', async () => {
    const singleFilePlan: ImplementationPlan = {
      ...MOCK_PLAN,
      files_to_create: [{ path: 'src/routes/items.ts', purpose: 'CRUD route handlers' }],
      files_to_modify: [],
    };

    const tscErr = makeTscError(["src/routes/items.ts(1,1): error TS2322: Type error."]);
    mockExecSync
      .mockImplementationOnce(() => { throw tscErr; })
      .mockImplementationOnce(() => { throw tscErr; });

    const BAD = 'const x: number = "still broken";';
    mockCreate
      .mockResolvedValueOnce(makeLlmResponse(BAD))
      .mockResolvedValueOnce(makeLlmResponse(BAD));

    const output = await generateCode(singleFilePlan, MOCK_CONTEXT, MOCK_SPEC, { apiKey: 'test' });

    expect(output.files_created[0].content).toBe(BAD);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('throws if ANTHROPIC_API_KEY is not set', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    await expect(
      generateCode(MOCK_PLAN, MOCK_CONTEXT, MOCK_SPEC)
    ).rejects.toThrow('ANTHROPIC_API_KEY is required');

    if (saved) process.env.ANTHROPIC_API_KEY = saved;
  });

  it('passes temperature:0 to every LLM call', async () => {
    mockCreate
      .mockResolvedValueOnce(makeLlmResponse(ITEMS_ROUTE_TS))
      .mockResolvedValueOnce(makeLlmResponse(ITEMS_TEST_TS))
      .mockResolvedValueOnce(makeLlmResponse(MODIFIED_APP_TS));

    await generateCode(MOCK_PLAN, MOCK_CONTEXT, MOCK_SPEC, { apiKey: 'test' });

    for (const [call] of mockCreate.mock.calls) {
      expect((call as { temperature: number }).temperature).toBe(0);
    }
  });

  it('generated test file contains 401 assertion', async () => {
    mockCreate
      .mockResolvedValueOnce(makeLlmResponse(ITEMS_ROUTE_TS))
      .mockResolvedValueOnce(makeLlmResponse(ITEMS_TEST_TS))
      .mockResolvedValueOnce(makeLlmResponse(MODIFIED_APP_TS));

    const output = await generateCode(MOCK_PLAN, MOCK_CONTEXT, MOCK_SPEC, { apiKey: 'test' });
    const testFile = output.files_created.find(f => f.path.includes('test'));
    expect(testFile?.content).toContain('401');
  });
});
