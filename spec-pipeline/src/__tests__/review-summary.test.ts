import { generateReviewSummary } from '../review-summary';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
jest.mock('node-fetch', () => jest.fn());
jest.mock('@anthropic-ai/sdk', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: '["No error handling on the write path.", "Missing input validation on request body.", "No rate limiting on new endpoints."]' }],
        }),
      },
    })),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockFetch = require('node-fetch') as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const SAMPLE_DIFF = `diff --git a/src/routes/items.ts b/src/routes/items.ts
new file mode 100644
index 0000000..abcdef1
--- /dev/null
+++ b/src/routes/items.ts
@@ -0,0 +1,20 @@
+import express from 'express';
+const router = express.Router();
+router.get('/', (req, res) => res.json([]));
+export default router;
diff --git a/src/routes/__tests__/items.test.ts b/src/routes/__tests__/items.test.ts
new file mode 100644
index 0000000..fedcba9
--- /dev/null
+++ b/src/routes/__tests__/items.test.ts
@@ -0,0 +1,10 @@
+import request from 'supertest';
+import app from '../../app';
+describe('items', () => {
+  it('returns empty array initially', async () => {
+    const res = await request(app).get('/items');
+    expect(res.status).toBe(200);
+  });
+  test('POST /items creates an item', async () => {
+    expect(true).toBe(true);
+  });
+});
diff --git a/src/app.ts b/src/app.ts
index 1234567..abcdef0 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,5 @@
 import express from 'express';
 const app = express();
+import itemsRouter from './routes/items';
+app.use('/items', itemsRouter);
 export default app;
`;

function ghDiffOk(body: string) {
  return { ok: true, status: 200, text: () => Promise.resolve(body) };
}

function ghCommentOk() {
  return { ok: true, status: 201, text: () => Promise.resolve('{}') };
}

const BASE_OPTIONS = {
  prUrl: 'https://github.com/MohammedAlsabih/spec-pipeline-demo-app/pull/42',
  prNumber: 42,
  owner: 'MohammedAlsabih',
  repo: 'spec-pipeline-demo-app',
  githubToken: 'test-token',
  anthropicApiKey: 'test-api-key',
  postComment: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('generateReviewSummary', () => {
  beforeEach(() => mockFetch.mockReset());

  it('extracts files_touched from diff', async () => {
    mockFetch
      .mockResolvedValueOnce(ghDiffOk(SAMPLE_DIFF))  // diff fetch
      .mockResolvedValueOnce(ghCommentOk());           // comment post

    const result = await generateReviewSummary(BASE_OPTIONS);

    expect(result.files_touched).toContain('src/routes/items.ts');
    expect(result.files_touched).toContain('src/routes/__tests__/items.test.ts');
    expect(result.files_touched).toContain('src/app.ts');
    expect(result.files_touched).toHaveLength(3);
  });

  it('extracts test names from added lines', async () => {
    mockFetch
      .mockResolvedValueOnce(ghDiffOk(SAMPLE_DIFF))
      .mockResolvedValueOnce(ghCommentOk());

    const result = await generateReviewSummary(BASE_OPTIONS);

    expect(result.tests_added).toContain('returns empty array initially');
    expect(result.tests_added).toContain('POST /items creates an item');
  });

  it('review_md contains all three required sections', async () => {
    mockFetch
      .mockResolvedValueOnce(ghDiffOk(SAMPLE_DIFF))
      .mockResolvedValueOnce(ghCommentOk());

    const result = await generateReviewSummary(BASE_OPTIONS);

    expect(result.review_md).toContain('### Files touched');
    expect(result.review_md).toContain('### Tests added');
    expect(result.review_md).toContain('### Risks');
  });

  it('risks array has at least 1 entry', async () => {
    mockFetch
      .mockResolvedValueOnce(ghDiffOk(SAMPLE_DIFF))
      .mockResolvedValueOnce(ghCommentOk());

    const result = await generateReviewSummary(BASE_OPTIONS);

    expect(result.risks.length).toBeGreaterThanOrEqual(1);
  });

  it('posts review_md as PR comment', async () => {
    let capturedBody: { body: string } | undefined;
    mockFetch
      .mockResolvedValueOnce(ghDiffOk(SAMPLE_DIFF))
      .mockImplementationOnce((_url: string, init: { body: string }) => {
        capturedBody = JSON.parse(init.body);
        return Promise.resolve(ghCommentOk());
      });

    const result = await generateReviewSummary(BASE_OPTIONS);

    expect(capturedBody?.body).toBe(result.review_md);
    expect(capturedBody?.body).toContain('### Files touched');
  });

  it('throws if GITHUB_TOKEN is not set', async () => {
    const saved = process.env.GITHUB_TOKEN;
    const savedGh = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;

    await expect(
      generateReviewSummary({ ...BASE_OPTIONS, githubToken: undefined })
    ).rejects.toThrow('GITHUB_TOKEN is required');

    if (saved) process.env.GITHUB_TOKEN = saved;
    if (savedGh) process.env.GH_TOKEN = savedGh;
  });

  it('falls back to heuristic risks when no API key is provided', async () => {
    mockFetch
      .mockResolvedValueOnce(ghDiffOk(SAMPLE_DIFF))
      .mockResolvedValueOnce(ghCommentOk());

    const result = await generateReviewSummary({ ...BASE_OPTIONS, anthropicApiKey: undefined });

    expect(result.risks.length).toBeGreaterThanOrEqual(1);
    expect(result.review_md).toContain('### Risks');
  });

  it('does not post comment when postComment is false', async () => {
    mockFetch.mockResolvedValueOnce(ghDiffOk(SAMPLE_DIFF));

    await generateReviewSummary({ ...BASE_OPTIONS, postComment: false });

    // Only one fetch call (the diff GET), no comment POST
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('review_md includes the PR URL', async () => {
    mockFetch
      .mockResolvedValueOnce(ghDiffOk(SAMPLE_DIFF))
      .mockResolvedValueOnce(ghCommentOk());

    const result = await generateReviewSummary(BASE_OPTIONS);

    expect(result.review_md).toContain(BASE_OPTIONS.prUrl);
  });
});
