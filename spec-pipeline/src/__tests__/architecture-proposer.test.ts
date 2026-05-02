import { proposeArchitecture, ArchProposerError } from '../architecture-proposer';
import type { ParsedSpec } from '../spec-parser';
import type { RepoContext } from '../repo-context';

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const DEMO_SPEC: ParsedSpec = {
  feature_description: 'Add an authenticated CRUD API for items. Auth is JWT. Use the existing middleware. Add tests for create and delete. Return 401 if unauthenticated.',
  tech_constraints: {
    language: 'typescript',
    framework: 'express',
    auth_pattern: 'jwt',
    test_coverage_required: true,
  },
  acceptance_criteria: [
    'POST /items returns 201 with created item',
    'GET /items returns 200 with item list',
    'DELETE /items/:id returns 204',
    'All routes return 401 if JWT is missing or invalid',
  ],
  file_hints: ['src/middleware/jwt.ts', 'src/routes/', 'src/app.ts'],
  raw_markdown: '',
};

const DEMO_CONTEXT: RepoContext = {
  repo_url: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app',
  owner: 'MohammedAlsabih',
  repo: 'spec-pipeline-demo-app',
  default_branch: 'master',
  file_tree: ['src/app.ts', 'src/middleware/jwt.ts', 'src/routes/users.ts', 'src/__tests__/users.test.ts', 'package.json'],
  existing_routes: [
    { method: 'GET', path: '/', file: 'src/routes/users.ts' },
    { method: 'GET', path: '/:id', file: 'src/routes/users.ts' },
  ],
  auth_pattern: 'jwt',
  test_framework: 'jest',
  key_files: [
    {
      path: 'src/middleware/jwt.ts',
      content: "import jwt from 'jsonwebtoken';\nexport function verifyJwt(req, res, next) { ... }",
      summary: 'JWT middleware that verifies Bearer tokens.',
    },
    {
      path: 'src/routes/users.ts',
      content: "const router = Router();\nrouter.get('/', verifyJwt, ...);\nrouter.get('/:id', verifyJwt, ...);",
      summary: 'Authenticated GET routes for users resource.',
    },
  ],
};

const VALID_PLAN_JSON = JSON.stringify({
  summary: 'Add authenticated CRUD API for items resource using existing JWT middleware',
  files_to_create: [
    { path: 'src/routes/items.ts', purpose: 'CRUD route handlers for items' },
    { path: 'src/routes/__tests__/items.test.ts', purpose: 'Jest tests for create, delete, and 401' },
  ],
  files_to_modify: [
    { path: 'src/app.ts', change: 'register items router', line_hint: 10 },
  ],
  interfaces: [
    { name: 'Item', fields: [{ name: 'id', type: 'string', optional: false }, { name: 'name', type: 'string', optional: false }] },
  ],
  test_cases: [
    'POST /items returns 201 with created item',
    'DELETE /items/:id returns 204',
    'POST /items returns 401 without auth',
  ],
});

function makeLlmResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 100, output_tokens: 200 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('proposeArchitecture', () => {
  beforeEach(() => mockCreate.mockReset());

  it('returns a valid ImplementationPlan from clean LLM JSON', async () => {
    mockCreate.mockResolvedValueOnce(makeLlmResponse(VALID_PLAN_JSON));

    const plan = await proposeArchitecture(DEMO_SPEC, DEMO_CONTEXT, { apiKey: 'test-key' });

    expect(plan.summary).toContain('items');
    expect(plan.files_to_create).toHaveLength(2);
    expect(plan.files_to_create[0].path).toBe('src/routes/items.ts');
    expect(plan.files_to_modify[0].path).toBe('src/app.ts');
    expect(plan.test_cases.length).toBeGreaterThanOrEqual(2);
  });

  it('strips markdown code fences from LLM output', async () => {
    const fenced = `Sure, here is the plan:\n\`\`\`json\n${VALID_PLAN_JSON}\n\`\`\`\nLet me know if you need changes.`;
    mockCreate.mockResolvedValueOnce(makeLlmResponse(fenced));

    const plan = await proposeArchitecture(DEMO_SPEC, DEMO_CONTEXT, { apiKey: 'test-key' });
    expect(plan.summary).toBeTruthy();
  });

  it('retries once on schema validation failure and succeeds on second attempt', async () => {
    mockCreate
      .mockResolvedValueOnce(makeLlmResponse('not valid json at all'))
      .mockResolvedValueOnce(makeLlmResponse(VALID_PLAN_JSON));

    const plan = await proposeArchitecture(DEMO_SPEC, DEMO_CONTEXT, { apiKey: 'test-key' });
    expect(plan.files_to_create).toHaveLength(2);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('throws ArchProposerError after exhausting retries', async () => {
    mockCreate.mockResolvedValue(makeLlmResponse('{ broken json'));

    await expect(
      proposeArchitecture(DEMO_SPEC, DEMO_CONTEXT, { apiKey: 'test-key', maxRetries: 1 })
    ).rejects.toThrow(ArchProposerError);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('accepts line_hint: null in files_to_modify', async () => {
    const planWithNullHint = JSON.stringify({
      ...JSON.parse(VALID_PLAN_JSON),
      files_to_modify: [{ path: 'src/app.ts', change: 'register items router', line_hint: null }],
    });
    mockCreate.mockResolvedValueOnce(makeLlmResponse(planWithNullHint));

    const plan = await proposeArchitecture(DEMO_SPEC, DEMO_CONTEXT, { apiKey: 'test-key' });
    expect(plan.files_to_modify[0].line_hint).toBeNull();
  });

  it('throws if ANTHROPIC_API_KEY is not set and no apiKey option given', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    await expect(
      proposeArchitecture(DEMO_SPEC, DEMO_CONTEXT)
    ).rejects.toThrow('ANTHROPIC_API_KEY is required');

    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it('plan includes test_cases covering the 401 unauthenticated path', async () => {
    mockCreate.mockResolvedValueOnce(makeLlmResponse(VALID_PLAN_JSON));

    const plan = await proposeArchitecture(DEMO_SPEC, DEMO_CONTEXT, { apiKey: 'test-key' });
    const has401 = plan.test_cases.some(tc => tc.includes('401'));
    expect(has401).toBe(true);
  });

  it('passes temperature:0 to the LLM call for determinism', async () => {
    mockCreate.mockResolvedValueOnce(makeLlmResponse(VALID_PLAN_JSON));

    await proposeArchitecture(DEMO_SPEC, DEMO_CONTEXT, { apiKey: 'test-key' });

    const callArgs = mockCreate.mock.calls[0][0] as { temperature: number };
    expect(callArgs.temperature).toBe(0);
  });
});
