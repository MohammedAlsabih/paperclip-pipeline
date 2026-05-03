import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import fetch from 'node-fetch';
import { CodegenOutput } from '../code-generator';
import { ImplementationPlan } from '../architecture-proposer';
import {
  checkInstallationAdmin,
  type AdminCheckLogger,
  type AdminCheckResult,
  type InstallationLookup,
} from '../repo-auth';

const GH_API = 'https://api.github.com';

export interface PrResult {
  pr_url: string;
  pr_number: number;
  branch: string;
  html_url: string;
}

// MAL-47 defense-in-depth: the same admin check the intake gate runs is
// re-invoked at PR-open. If the customer revoked the App (or lost admin)
// between submission and now, we fail closed before pushing. Surface this
// as PrAuthorizationRejection so callers can tell auth rejections apart
// from network or git errors.
export interface PrCreatorAdminRecheck {
  userId: string;
  userToken: string;
  lookup: InstallationLookup;
  logger: AdminCheckLogger;
}

export class PrAuthorizationRejection extends Error {
  constructor(public readonly result: Extract<AdminCheckResult, { ok: false }>) {
    super(result.safeMessage);
    this.name = 'PrAuthorizationRejection';
  }
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

async function ghPost(path: string, body: unknown, token: string) {
  const res = await fetch(`${GH_API}${path}`, {
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
    throw new Error(`GitHub API POST ${path} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

export async function createPr(options: {
  repoUrl: string;
  defaultBranch: string;
  codegenOutput: CodegenOutput;
  plan: ImplementationPlan;
  githubToken?: string;
  // MAL-47 defense-in-depth: when set, re-runs the spec-submission admin
  // check immediately before clone/push. If the App was uninstalled or the
  // user lost admin between submission and now, we throw
  // PrAuthorizationRejection and never push or open a PR.
  adminRecheck?: PrCreatorAdminRecheck;
}): Promise<PrResult> {
  const { repoUrl, defaultBranch, codegenOutput, plan } = options;
  const token = options.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required for PR creator');

  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Cannot parse GitHub URL: ${repoUrl}`);
  const [, owner, repo] = match;

  // MAL-47 defense-in-depth re-check. Runs before any clone or push so a
  // revoked installation cannot result in a partial push or a PR opened
  // against a repo the user no longer admins. Failure surfaces the same
  // safe (non-leaky) message as the intake gate.
  if (options.adminRecheck) {
    const recheck = await checkInstallationAdmin(
      {
        userId: options.adminRecheck.userId,
        userToken: options.adminRecheck.userToken,
        repoUrl,
        stage: 'pr-open',
      },
      {
        lookup: options.adminRecheck.lookup,
        logger: options.adminRecheck.logger,
      },
    );
    if (!recheck.ok) {
      throw new PrAuthorizationRejection(recheck);
    }
  }

  const branch = branchName(plan.summary);
  const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  // Clone into a temp directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-pr-'));
  try {
    const git = simpleGit(tmpDir);
    await git.clone(cloneUrl, tmpDir, ['--depth', '1', '--branch', defaultBranch]);
    await git.addConfig('user.email', 'pipeline@spec-to-pr.local');
    await git.addConfig('user.name', 'Spec-to-PR Pipeline');

    // Create feature branch
    await git.checkoutLocalBranch(branch);

    // Apply created files
    for (const f of codegenOutput.files_created) {
      const filePath = path.join(tmpDir, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, f.content, 'utf-8');
    }

    // Apply modified files (use full new_content for simplicity and reliability)
    for (const f of codegenOutput.files_modified) {
      const filePath = path.join(tmpDir, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, f.new_content, 'utf-8');
    }

    // Commit
    const allPaths = [
      ...codegenOutput.files_created.map(f => f.path),
      ...codegenOutput.files_modified.map(f => f.path),
    ];
    await git.add(allPaths);
    await git.commit(`feat: ${plan.summary}\n\nGenerated by spec-to-PR pipeline v1`);

    // Push
    await git.push('origin', branch);
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
