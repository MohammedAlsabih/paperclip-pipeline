import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import fetch from 'node-fetch';
import { CodegenOutput } from '../code-generator';
import { ImplementationPlan } from '../architecture-proposer';

const GH_API = 'https://api.github.com';

export interface PrResult {
  pr_url: string;
  pr_number: number;
  branch: string;
  html_url: string;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function branchName(summary: string): string {
  const ts = Date.now();
  return `spec-pr/${ts}-${slug(summary)}`;
}

// Resolve `relPath` relative to `root` and reject anything that escapes the
// root directory (path traversal) or is absolute. The LLM controls
// codegenOutput.files_*[].path, so unconfined path.join would let it write
// outside tmpDir (e.g. `../../../etc/x`).
export function safeJoin(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error(`safeJoin: empty or non-string path`);
  }
  if (path.isAbsolute(relPath)) {
    throw new Error(`safeJoin: refusing absolute path: ${relPath}`);
  }
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, relPath);
  const rel = path.relative(normalizedRoot, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`safeJoin: path escapes root: ${relPath}`);
  }
  return resolved;
}

async function ghPost(p: string, body: unknown, token: string) {
  const res = await fetch(`${GH_API}${p}`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`GitHub API POST ${p} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// Defense-in-depth: even with token-out-of-URL, redact the token from any
// error string before it bubbles up, so an unexpected logger or stack trace
// can't leak it.
function redactToken<T>(token: string, fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    const redacted = msg.split(token).join('***');
    if (err instanceof Error) {
      err.message = redacted;
      throw err;
    }
    throw new Error(redacted);
  });
}

export async function createPr(options: {
  repoUrl: string;
  defaultBranch: string;
  codegenOutput: CodegenOutput;
  plan: ImplementationPlan;
  githubToken?: string;
}): Promise<PrResult> {
  const { repoUrl, defaultBranch, codegenOutput, plan } = options;
  const token = options.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required for PR creator');

  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Cannot parse GitHub URL: ${repoUrl}`);
  const [, owner, repo] = match;

  const branch = branchName(plan.summary);
  // Token is NOT embedded in the URL. Authentication is provided via a git
  // -c http.extraHeader config flag, scoped to this clone/push only. This
  // keeps the token out of any URL string that git logs on failure.
  const cleanCloneUrl = `https://github.com/${owner}/${repo}.git`;
  const authHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  const gitConfig = [`http.extraHeader=${authHeader}`];

  // Clone into a temp directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-pr-'));
  try {
    const git = simpleGit({ config: gitConfig });
    await redactToken(token, () =>
      git.clone(cleanCloneUrl, tmpDir, ['--depth', '1', '--branch', defaultBranch])
    );

    const repoGit = simpleGit(tmpDir, { config: gitConfig });
    await repoGit.addConfig('user.email', 'pipeline@spec-to-pr.local');
    await repoGit.addConfig('user.name', 'Spec-to-PR Pipeline');

    // Create feature branch
    await repoGit.checkoutLocalBranch(branch);

    // Apply created files (path.join → safeJoin to block traversal)
    for (const f of codegenOutput.files_created) {
      const filePath = safeJoin(tmpDir, f.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, f.content, 'utf-8');
    }

    // Apply modified files (use full new_content for simplicity and reliability)
    for (const f of codegenOutput.files_modified) {
      const filePath = safeJoin(tmpDir, f.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, f.new_content, 'utf-8');
    }

    // Commit
    const allPaths = [
      ...codegenOutput.files_created.map(f => f.path),
      ...codegenOutput.files_modified.map(f => f.path),
    ];
    await repoGit.add(allPaths);
    await repoGit.commit(`feat: ${plan.summary}\n\nGenerated by spec-to-PR pipeline v1`);

    // Push
    await redactToken(token, () => repoGit.push('origin', branch));
  } finally {
    // Cleanup regardless of success/failure
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Open PR via GitHub API
  const filesChanged = [
    ...codegenOutput.files_created.map(f => `- \`${f.path}\` (created)`),
    ...codegenOutput.files_modified.map(f => `- \`${f.path}\` (modified)`),
  ].join('\n');

  const prBody = `## Summary\n\n${plan.summary}\n\n## Files changed\n\n${filesChanged}\n\n## Generated by\n\nSpec-to-PR pipeline v1 — automated code generation`;

  const prData = await ghPost(`/repos/${owner}/${repo}/pulls`, {
    title: plan.summary,
    head: branch,
    base: defaultBranch,
    body: prBody,
    draft: false,
  }, token) as { number: number; html_url: string };

  return {
    pr_url: prData.html_url,
    pr_number: prData.number,
    branch,
    html_url: prData.html_url,
  };
}
