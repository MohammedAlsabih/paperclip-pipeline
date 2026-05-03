import * as fs from 'fs';
import { parseSpec } from '../spec-parser';
import { extractRepoContext } from '../repo-context';
import { proposeArchitecture } from '../architecture-proposer';
import { generateCode } from '../code-generator';
import { createPr } from '../pr-creator';
import { generateReviewSummary } from '../review-summary';
import {
  checkInstallationAdmin,
  type AdminCheckLogger,
  type AdminCheckResult,
  type InstallationLookup,
} from '../repo-auth';

export interface AdminAuthConfig {
  // Stable identifier for the requesting user. Whatever the caller uses to
  // attribute pipeline runs (email hash, GitHub user ID, internal user UUID).
  userId: string;
  // OAuth user token. Used to query GitHub for the user's installations and
  // their repo permission. Must be a user token, not an installation token.
  userToken: string;
  lookup: InstallationLookup;
  logger: AdminCheckLogger;
}

export interface PipelineOptions {
  specPath: string;
  repoUrl: string;
  githubToken?: string;
  anthropicApiKey?: string;
  verbose?: boolean;
  // MAL-47 / threat T17/O4: optional admin-validation gate. If supplied,
  // the pipeline asserts the requesting user (`adminAuth.userId`) has the
  // GitHub App installed on `repoUrl` and holds admin on it BEFORE any LLM
  // call or repo clone. Local CLI demos may omit it (single-user mode);
  // multi-tenant deploys MUST pass it. The same shape is re-invoked from
  // `pr-creator` as defense-in-depth at PR-open.
  adminAuth?: AdminAuthConfig;
}

// Thrown when the admin-validation gate rejects the request. Carries the
// safe (non-leaky) message for the API caller and the internal reason code
// for logs / metrics.
export class SpecAuthorizationRejection extends Error {
  constructor(public readonly result: Extract<AdminCheckResult, { ok: false }>) {
    super(result.safeMessage);
    this.name = 'SpecAuthorizationRejection';
  }
}

export interface PipelineResult {
  pr_url: string;
  pr_number: number;
  review_md: string;
  timings: Record<string, number>;
}

function log(verbose: boolean, msg: string) {
  if (verbose) process.stdout.write(msg + '\n');
}

function timed<T>(label: string, timings: Record<string, number>, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  return fn().then(result => {
    timings[label] = Date.now() - start;
    return result;
  });
}

// Helper: run the admin-validation gate. Exported so a future HTTP ingress
// can call this on its own at spec-submission time without invoking the
// rest of the pipeline (the issue framing is "fail fast at intake"). The
// pipeline below also calls it as the first step when `adminAuth` is set,
// so a single call to runPipeline is still safe in multi-tenant deploys.
export async function validateSpecSubmission(
  repoUrl: string,
  adminAuth: AdminAuthConfig,
): Promise<AdminCheckResult> {
  return checkInstallationAdmin(
    {
      userId: adminAuth.userId,
      userToken: adminAuth.userToken,
      repoUrl,
      stage: 'submission',
    },
    { lookup: adminAuth.lookup, logger: adminAuth.logger },
  );
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { specPath, repoUrl, verbose = true } = options;
  const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const anthropicApiKey = options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;

  const timings: Record<string, number> = {};

  // Step 0 (MAL-47): admin-validation gate. Runs before parse so an
  // unauthorized caller does not even get their spec normalized — we don't
  // want to hand a hostile actor diagnostics about parse-time validation.
  // Failure throws SpecAuthorizationRejection with a non-leaky message
  // (T9-clean): same generic reply for "no installation" and "not admin"
  // so a hostile probe can't enumerate which target repos have the App.
  if (options.adminAuth) {
    log(verbose, '→ [auth] Validating user-is-admin on target repo...');
    const authResult = await timed('admin_check', timings, () =>
      validateSpecSubmission(repoUrl, options.adminAuth!),
    );
    if (!authResult.ok) {
      log(verbose, `  ✗ Authorization rejected: ${authResult.reason}`);
      throw new SpecAuthorizationRejection(authResult);
    }
    log(verbose, `  ✓ User is admin on ${authResult.owner}/${authResult.repo}`);
  }

  // Step 1: Parse spec
  log(verbose, '→ [1/6] Parsing spec...');
  const rawSpec = fs.readFileSync(specPath, 'utf-8');
  const spec = await timed('spec_parse', timings, async () => parseSpec(rawSpec));
  log(verbose, `  ✓ Feature: "${spec.feature_description.slice(0, 80)}"`);

  // Step 2: Extract repo context
  log(verbose, '→ [2/6] Extracting repo context...');
  const context = await timed('repo_context', timings, () =>
    extractRepoContext({ repoUrl, fileHints: spec.file_hints, githubToken, anthropicApiKey })
  );
  log(verbose, `  ✓ ${context.file_tree.length} files, ${context.existing_routes.length} routes, auth: ${context.auth_pattern}`);

  // Step 3: Propose architecture
  log(verbose, '→ [3/6] Proposing architecture...');
  const plan = await timed('arch_propose', timings, () =>
    proposeArchitecture(spec, context, { apiKey: anthropicApiKey })
  );
  log(verbose, `  ✓ ${plan.files_to_create.length} files to create, ${plan.files_to_modify.length} to modify`);

  // Step 4: Generate code
  log(verbose, '→ [4/6] Generating code...');
  const codegenOutput = await timed('codegen', timings, () =>
    generateCode(plan, context, spec, { apiKey: anthropicApiKey })
  );
  log(verbose, `  ✓ Created: ${codegenOutput.files_created.map(f => f.path).join(', ')}`);
  log(verbose, `  ✓ Modified: ${codegenOutput.files_modified.map(f => f.path).join(', ')}`);

  // Step 5: Create PR
  log(verbose, '→ [5/6] Creating pull request...');
  if (!githubToken) throw new Error('GITHUB_TOKEN is required');
  const prResult = await timed('pr_create', timings, () =>
    createPr({
      repoUrl,
      defaultBranch: context.default_branch,
      codegenOutput,
      plan,
      githubToken,
      // MAL-47 defense-in-depth: re-run the admin check at PR-open. If the
      // installation was revoked between submission and now, this rejects
      // before we push. Logged with stage=pr-open so the audit trail can
      // tell intake checks from re-checks.
      adminRecheck: options.adminAuth,
    })
  );
  log(verbose, `  ✓ PR opened: ${prResult.pr_url}`);

  // Step 6: Generate review summary
  log(verbose, '→ [6/6] Generating review summary...');
  const { owner, repo } = context;
  const review = await timed('review', timings, () =>
    generateReviewSummary({
      prUrl: prResult.pr_url,
      prNumber: prResult.pr_number,
      owner,
      repo,
      githubToken,
      anthropicApiKey,
      postComment: true,
    })
  );
  log(verbose, `  ✓ Review posted to PR`);

  const totalMs = Object.values(timings).reduce((a, b) => a + b, 0);
  log(verbose, `\n✓ Pipeline complete in ${(totalMs / 1000).toFixed(1)}s`);
  log(verbose, `\n  PR:     ${prResult.pr_url}`);
  log(verbose, `\n${review.review_md}`);

  return {
    pr_url: prResult.pr_url,
    pr_number: prResult.pr_number,
    review_md: review.review_md,
    timings,
  };
}
