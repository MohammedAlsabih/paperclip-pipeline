import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';

const GH_API = 'https://api.github.com';

export interface ReviewSummary {
  files_touched: string[];
  tests_added: string[];
  risks: string[];
  review_md: string;
}

// ---------------------------------------------------------------------------
// Diff parsing helpers
// ---------------------------------------------------------------------------
function parseDiffFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (m) files.push(m[1]);
  }
  return [...new Set(files)];
}

function parseAddedTestNames(diff: string): string[] {
  const names: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const m = line.match(/(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (m) names.push(m[1]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------
async function ghGetDiff(owner: string, repo: string, prNumber: number, token: string): Promise<string> {
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      Accept: 'application/vnd.github.diff',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub GET diff ${prNumber} → ${res.status}: ${body}`);
  }
  return res.text();
}

async function ghPostComment(owner: string, repo: string, prNumber: number, body: string, token: string): Promise<void> {
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const data = await res.text();
    throw new Error(`GitHub POST comment → ${res.status}: ${data}`);
  }
}

// ---------------------------------------------------------------------------
// LLM risk analysis (Claude Haiku)
// ---------------------------------------------------------------------------
async function analyzeRisks(diff: string, apiKey: string): Promise<string[]> {
  const client = new Anthropic({ apiKey });

  // Keep diff under ~3000 chars to stay fast and cheap
  const diffSnippet = diff.length > 3000 ? diff.slice(0, 3000) + '\n... (truncated)' : diff;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    temperature: 0,
    messages: [{
      role: 'user',
      content: `You are a senior code reviewer. Identify 3-5 concrete risks or missing concerns in this PR diff.
Focus on: missing error handling, pagination, data persistence, race conditions, security gaps.
Each risk: one sentence, start with a capital letter, be specific.
Output ONLY a JSON array of strings, e.g. ["Risk 1", "Risk 2", "Risk 3"].

${diffSnippet}

Output the JSON array now:`,
    }],
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('');

  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]) as string[];
  } catch { /* fall through */ }

  return text.split('\n').filter(l => l.trim().length > 10).slice(0, 5);
}

function heuristicRisks(diff: string): string[] {
  const risks: string[] = [];
  if (!diff.includes('try') && !diff.includes('catch')) {
    risks.push('No error handling found in the diff — failures may be silently swallowed.');
  }
  if (!diff.includes('pagination') && !diff.includes('limit') && diff.includes('findAll')) {
    risks.push('List endpoint lacks pagination — could be slow with large datasets.');
  }
  risks.push('Input validation on request body fields is not verified in the diff.');
  if (risks.length < 3) {
    risks.push('Rate limiting is not applied to the new endpoints.');
  }
  return risks.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function generateReviewSummary(options: {
  prUrl: string;
  prNumber: number;
  owner: string;
  repo: string;
  githubToken?: string;
  anthropicApiKey?: string;
  postComment?: boolean;
}): Promise<ReviewSummary> {
  const { prUrl, prNumber, owner, repo } = options;
  const token = options.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required for review summary generator');
  const apiKey = options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  const postComment = options.postComment ?? true;

  // 1. Fetch PR diff
  const diff = await ghGetDiff(owner, repo, prNumber, token);

  // 2. Parse diff
  const files_touched = parseDiffFiles(diff);
  const tests_added = parseAddedTestNames(diff);

  // 3. Risk analysis
  let risks: string[];
  if (apiKey) {
    try {
      risks = await analyzeRisks(diff, apiKey);
    } catch {
      risks = heuristicRisks(diff);
    }
  } else {
    risks = heuristicRisks(diff);
  }

  // 4. Build review markdown
  const filesSection = files_touched.length > 0
    ? files_touched.map(f => `- \`${f}\``).join('\n')
    : '_No files detected._';

  const testsSection = tests_added.length > 0
    ? tests_added.map(t => `- \`${t}\``).join('\n')
    : '_No test names detected in added lines._';

  const risksSection = risks.map(r => `- ${r}`).join('\n');

  const review_md = `## Automated Review Summary

**PR:** ${prUrl}

### Files touched (${files_touched.length})

${filesSection}

### Tests added (${tests_added.length})

${testsSection}

### Risks

${risksSection}

---
_Generated by spec-to-PR pipeline v1_`;

  // 5. Post as PR comment
  if (postComment) {
    await ghPostComment(owner, repo, prNumber, review_md, token);
  }

  return { files_touched, tests_added, risks, review_md };
}
