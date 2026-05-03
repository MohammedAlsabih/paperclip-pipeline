// Spec-submission admin-validation guard (MAL-47 / threat-model T17/O4).
//
// At spec-submission time we re-validate that the human submitting the spec
// (a) has the GitHub App installed on the declared target repo, and (b)
// holds admin on that repo. GitHub's install flow already requires repo
// admin, but a stale install — or a user who lost admin since installing —
// could otherwise drive our pipeline against a repo they no longer own.
// Failing fast here is cheaper than failing at PR-open and avoids spending
// LLM budget on an unauthorized run.
//
// The validator is pure (no fetch, no clock). It composes one or two ports
// on `InstallationLookup` and emits one log line per call (success or
// failure) per SECURITY_POLICY.md §6.

import {
  AdminCheckLogger,
  AdminCheckOutcome,
  InstallationLookup,
  InstalledRepo,
  RepoPermission,
  RepoRef,
  TokenRevokedError,
} from './types';

// Permission levels that satisfy the issue's "write+admin" requirement.
// Per the issue text we require `admin`. `maintain` is intentionally
// excluded — it can manage repo settings but cannot, e.g., delete the repo,
// and the threat model treats admin as the bar.
const ADMIN_PERMISSIONS: ReadonlySet<RepoPermission> = new Set<RepoPermission>(['admin']);

export interface AdminCheckContext {
  userId: string;
  userToken: string;
  // Either a github.com URL or `owner/repo`. We accept the same shape the
  // CLI does to avoid a separate parse step at the call site.
  repoUrl: string;
  // Whether this is the intake check (spec submission) or the defense-
  // in-depth re-check at PR-open time. The check logic is identical; the
  // stage value is only used in logs so the audit trail can tell them apart.
  stage?: 'submission' | 'pr-open';
}

export type AdminCheckResult =
  | {
      ok: true;
      installationId: number;
      permission: RepoPermission;
      owner: string;
      repo: string;
    }
  | {
      ok: false;
      reason:
        | 'no-installation'
        | 'not-admin'
        | 'token-invalid'
        | 'malformed-repo-url'
        | 'lookup-failed';
      // Caller-safe message — what we surface to the API. T9-clean: never
      // tells the caller whether a repo is installed-but-not-admin vs not-
      // installed-at-all, so a hostile user cannot enumerate installations.
      safeMessage: string;
      // The matched permission level when known (not-admin path only).
      permission?: RepoPermission;
    };

// Strip a github.com URL or owner/repo string into a RepoRef. Returns null
// for anything that doesn't look like a GitHub repo path; the validator
// rejects with `malformed-repo-url` rather than throwing so all rejections
// flow through the same logging shape.
export function parseRepoRef(input: string): RepoRef | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  const trimmed = input.trim();
  // Try github.com URL first (with optional protocol, .git suffix, trailing slash).
  const urlMatch = trimmed.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2] };
  }
  // Plain owner/repo form.
  const slashMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (slashMatch) {
    return { owner: slashMatch[1], repo: slashMatch[2] };
  }
  return null;
}

function eqRepo(a: RepoRef, b: RepoRef): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase();
}

function findInstallation(
  installations: ReadonlyArray<InstalledRepo>,
  target: RepoRef,
): InstalledRepo | null {
  for (const i of installations) {
    if (eqRepo(i, target)) return i;
  }
  return null;
}

// Generic, non-leaky messages. T9-clean: from the API caller's perspective,
// "no-installation" and "not-admin" produce indistinguishable replies so a
// hostile user cannot probe whether a target repo has the App installed.
const SAFE_MESSAGE_AUTHORIZATION =
  'Spec rejected: target repo is not authorized for this user. Install the App on the repo and confirm you have admin permission.';
const SAFE_MESSAGE_TOKEN =
  'Spec rejected: GitHub token is no longer valid. Please reauthenticate.';
const SAFE_MESSAGE_MALFORMED =
  'Spec rejected: repo URL is malformed.';
const SAFE_MESSAGE_LOOKUP =
  'Spec rejected: could not verify repo authorization. Please retry.';

export async function checkInstallationAdmin(
  ctx: AdminCheckContext,
  deps: { lookup: InstallationLookup; logger: AdminCheckLogger },
): Promise<AdminCheckResult> {
  const stage = ctx.stage ?? 'submission';
  const parsed = parseRepoRef(ctx.repoUrl);
  if (!parsed) {
    deps.logger.log({
      userId: ctx.userId,
      owner: '',
      repo: '',
      outcome: 'rejected-malformed-repo-url',
      reason: 'parse-failed',
      stage,
    });
    return {
      ok: false,
      reason: 'malformed-repo-url',
      safeMessage: SAFE_MESSAGE_MALFORMED,
    };
  }

  let installations: InstalledRepo[];
  try {
    installations = await deps.lookup.listUserInstallations(ctx.userToken);
  } catch (err) {
    return rejectFromLookupError(err, ctx, parsed, stage, deps.logger);
  }

  const matched = findInstallation(installations, parsed);
  if (!matched) {
    deps.logger.log({
      userId: ctx.userId,
      owner: parsed.owner,
      repo: parsed.repo,
      outcome: 'rejected-no-installation',
      reason: 'repo-not-in-installations',
      stage,
    });
    return {
      ok: false,
      reason: 'no-installation',
      safeMessage: SAFE_MESSAGE_AUTHORIZATION,
    };
  }

  let permission: RepoPermission;
  try {
    permission = await deps.lookup.getUserRepoPermission(ctx.userToken, parsed);
  } catch (err) {
    return rejectFromLookupError(err, ctx, parsed, stage, deps.logger);
  }

  if (!ADMIN_PERMISSIONS.has(permission)) {
    deps.logger.log({
      userId: ctx.userId,
      owner: parsed.owner,
      repo: parsed.repo,
      outcome: 'rejected-not-admin',
      reason: `permission=${permission}`,
      permission,
      installationId: matched.installationId,
      stage,
    });
    return {
      ok: false,
      reason: 'not-admin',
      safeMessage: SAFE_MESSAGE_AUTHORIZATION,
      permission,
    };
  }

  deps.logger.log({
    userId: ctx.userId,
    owner: parsed.owner,
    repo: parsed.repo,
    outcome: 'admitted',
    permission,
    installationId: matched.installationId,
    stage,
  });
  return {
    ok: true,
    installationId: matched.installationId,
    permission,
    owner: parsed.owner,
    repo: parsed.repo,
  };
}

function rejectFromLookupError(
  err: unknown,
  ctx: AdminCheckContext,
  parsed: RepoRef,
  stage: 'submission' | 'pr-open',
  logger: AdminCheckLogger,
): AdminCheckResult {
  if (err instanceof TokenRevokedError) {
    logger.log({
      userId: ctx.userId,
      owner: parsed.owner,
      repo: parsed.repo,
      outcome: 'rejected-token-invalid',
      reason: err.hint ?? '401',
      stage,
    });
    return {
      ok: false,
      reason: 'token-invalid',
      safeMessage: SAFE_MESSAGE_TOKEN,
    };
  }
  // Anything else — network error, 5xx from GitHub, malformed JSON — is a
  // lookup failure. Fail closed (reject the spec) so a transient GitHub
  // outage cannot bypass authorization, and surface a generic retry message.
  const reason = err instanceof Error ? err.name : 'unknown';
  logger.log({
    userId: ctx.userId,
    owner: parsed.owner,
    repo: parsed.repo,
    outcome: 'rejected-lookup-failed',
    reason,
    stage,
  });
  return {
    ok: false,
    reason: 'lookup-failed',
    safeMessage: SAFE_MESSAGE_LOOKUP,
  };
}

export function adminOutcomeForResult(result: AdminCheckResult): AdminCheckOutcome {
  if (result.ok) return 'admitted';
  switch (result.reason) {
    case 'no-installation':
      return 'rejected-no-installation';
    case 'not-admin':
      return 'rejected-not-admin';
    case 'token-invalid':
      return 'rejected-token-invalid';
    case 'malformed-repo-url':
      return 'rejected-malformed-repo-url';
    case 'lookup-failed':
      return 'rejected-lookup-failed';
  }
}
