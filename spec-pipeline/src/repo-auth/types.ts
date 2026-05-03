// Storage / network ports for the spec-submission admin-validation guard
// (MAL-47 / T17/O4). The validator is pure: anything that touches GitHub —
// listing installations, checking repo permissions, validating a token —
// goes through `InstallationLookup` so the same code drives the live GitHub
// adapter in prod and an in-memory fake in tests.

export type RepoPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

// A repo addressed by owner/name. Comparisons are case-insensitive: GitHub
// normalizes path segments and we must match the same way to avoid letting
// `Acme/repo` slip past a check that was built against `acme/repo`.
export interface RepoRef {
  owner: string;
  repo: string;
}

export interface InstalledRepo extends RepoRef {
  installationId: number;
}

export interface InstallationLookup {
  // List the GitHub App installations accessible to the requesting user.
  // The `userToken` is a user OAuth token (NOT an installation token) and
  // identifies who is submitting the spec. Implementations MUST raise a
  // `TokenRevokedError` if GitHub returns 401 — the validator distinguishes
  // a revoked-or-expired token from a permission denial so the log is
  // accurate (and so a defense-in-depth re-check can re-run cleanly).
  listUserInstallations(userToken: string): Promise<InstalledRepo[]>;

  // Return the requesting user's permission level on `repo`. Used to enforce
  // the issue's "write+admin" requirement: GitHub's installation flow already
  // requires admin to install the App, but users in the same org may have
  // varying repo-level perms. We require `admin` on the repo at submission.
  // Implementations MUST raise `TokenRevokedError` on 401.
  getUserRepoPermission(userToken: string, repo: RepoRef): Promise<RepoPermission>;
}

// Sentinel error: the user's OAuth token is no longer valid (revoked or
// expired). The validator surfaces this as `rejected-token-invalid` so the
// caller can ask the user to reauthenticate rather than guessing whether
// the failure was a permission denial.
export class TokenRevokedError extends Error {
  constructor(public readonly hint?: string) {
    super('user token is revoked or expired');
    this.name = 'TokenRevokedError';
  }
}

// Logging port. Per SECURITY_POLICY.md §6 we record every authorization
// check (success and failure) and never serialize the token, raw response
// body, or any field beyond the whitelisted shape below.
export interface AdminCheckLogger {
  log(entry: AdminCheckLogEntry): void;
}

export type AdminCheckOutcome =
  | 'admitted'
  | 'rejected-no-installation'
  | 'rejected-not-admin'
  | 'rejected-token-invalid'
  | 'rejected-malformed-repo-url'
  | 'rejected-lookup-failed';

export interface AdminCheckLogEntry {
  // Stable identifier for the requesting user. Whatever the caller uses to
  // attribute pipeline runs (email hash, GitHub user ID, internal user UUID)
  // — same string as the rate-limit `userId` so logs cross-correlate.
  userId: string;
  owner: string;
  repo: string;
  outcome: AdminCheckOutcome;
  // Internal reason code, used for log filtering. NEVER surfaced to the API
  // caller (the safe-message field on the rejection result is what we send
  // back to the client per T9-clean).
  reason?: string;
  // Resolved permission level when we got far enough to know it. Omitted on
  // not-installed / token-invalid paths because we never asked.
  permission?: RepoPermission;
  // Installation id we matched (admitted path only).
  installationId?: number;
  // Set when the check is the defense-in-depth re-check that runs at PR-open
  // time (MAL-47 acceptance criterion 4). Helps separate intake checks from
  // pre-push checks in the audit log.
  stage: 'submission' | 'pr-open';
}
