// Unit tests for the spec-submission admin-validation guard (MAL-47 / T17/O4).
//
// Covers the four acceptance scenarios from the issue:
//   1. Admin on installed repo → spec accepted.
//   2. User has read-only on the repo → spec rejected.
//   3. Repo not in user's installations → spec rejected.
//   4. App revoked between submission and PR-open → PR creation re-checks.
//
// Plus T9-clean assertions: the safeMessage for "no installation" and
// "not admin" must be IDENTICAL so a hostile caller cannot probe whether
// a target repo has the App installed.

import {
  checkInstallationAdmin,
  parseRepoRef,
  TokenRevokedError,
  type AdminCheckLogEntry,
  type AdminCheckLogger,
  type InstallationLookup,
  type InstalledRepo,
  type RepoPermission,
  type RepoRef,
} from '../repo-auth';

interface FakeOptions {
  installations?: InstalledRepo[];
  permission?: RepoPermission;
  // When true, the lookup throws TokenRevokedError on the first call.
  revokeToken?: boolean;
  // When true, listUserInstallations throws a generic Error (5xx / network).
  failOnList?: boolean;
  // When true, getUserRepoPermission throws a generic Error.
  failOnPermission?: boolean;
}

function makeFakeLookup(opts: FakeOptions): InstallationLookup & {
  callCount: { list: number; permission: number };
} {
  const callCount = { list: 0, permission: 0 };
  const lookup: InstallationLookup & { callCount: typeof callCount } = {
    callCount,
    async listUserInstallations() {
      callCount.list += 1;
      if (opts.revokeToken) throw new TokenRevokedError('401-test');
      if (opts.failOnList) throw new Error('boom');
      return opts.installations ?? [];
    },
    async getUserRepoPermission(_token: string, _repo: RepoRef) {
      callCount.permission += 1;
      if (opts.revokeToken) throw new TokenRevokedError('401-test');
      if (opts.failOnPermission) throw new Error('boom-perm');
      return opts.permission ?? 'none';
    },
  };
  return lookup;
}

function makeLogger(): AdminCheckLogger & { entries: AdminCheckLogEntry[] } {
  const entries: AdminCheckLogEntry[] = [];
  return {
    entries,
    log(entry) {
      entries.push(entry);
    },
  };
}

const REPO_URL = 'https://github.com/acme/widgets';

describe('parseRepoRef', () => {
  test.each([
    ['https://github.com/acme/widgets', { owner: 'acme', repo: 'widgets' }],
    ['https://github.com/acme/widgets.git', { owner: 'acme', repo: 'widgets' }],
    ['https://github.com/acme/widgets/', { owner: 'acme', repo: 'widgets' }],
    ['git@github.com:acme/widgets.git', { owner: 'acme', repo: 'widgets' }],
    ['acme/widgets', { owner: 'acme', repo: 'widgets' }],
    ['acme/widgets.git', { owner: 'acme', repo: 'widgets' }],
  ])('parses %s', (input, expected) => {
    expect(parseRepoRef(input)).toEqual(expected);
  });

  test.each([
    '',
    'not a url',
    'github.com',
    'https://example.com/acme/widgets',
    'acme//widgets',
    'acme widgets',
  ])('rejects %s', (input) => {
    expect(parseRepoRef(input)).toBeNull();
  });
});

describe('checkInstallationAdmin (MAL-47 / T17/O4)', () => {
  test('happy path: admin on installed repo → accepted', async () => {
    const lookup = makeFakeLookup({
      installations: [{ owner: 'acme', repo: 'widgets', installationId: 99 }],
      permission: 'admin',
    });
    const logger = makeLogger();
    const result = await checkInstallationAdmin(
      { userId: 'u1', userToken: 't', repoUrl: REPO_URL },
      { lookup, logger },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installationId).toBe(99);
      expect(result.permission).toBe('admin');
      expect(result.owner).toBe('acme');
      expect(result.repo).toBe('widgets');
    }
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      userId: 'u1',
      owner: 'acme',
      repo: 'widgets',
      outcome: 'admitted',
      permission: 'admin',
      installationId: 99,
      stage: 'submission',
    });
  });

  test('read-only on the repo → rejected (not-admin)', async () => {
    const lookup = makeFakeLookup({
      installations: [{ owner: 'acme', repo: 'widgets', installationId: 99 }],
      permission: 'read',
    });
    const logger = makeLogger();
    const result = await checkInstallationAdmin(
      { userId: 'u1', userToken: 't', repoUrl: REPO_URL },
      { lookup, logger },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not-admin');
      expect(result.permission).toBe('read');
    }
    expect(logger.entries[0]).toMatchObject({
      outcome: 'rejected-not-admin',
      permission: 'read',
      installationId: 99,
      stage: 'submission',
    });
  });

  test('write but not admin on the repo → rejected (issue requires admin, not write)', async () => {
    const lookup = makeFakeLookup({
      installations: [{ owner: 'acme', repo: 'widgets', installationId: 99 }],
      permission: 'write',
    });
    const logger = makeLogger();
    const result = await checkInstallationAdmin(
      { userId: 'u1', userToken: 't', repoUrl: REPO_URL },
      { lookup, logger },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-admin');
    expect(logger.entries[0]?.outcome).toBe('rejected-not-admin');
  });

  test('repo not in user installations → rejected (no-installation)', async () => {
    const lookup = makeFakeLookup({
      installations: [{ owner: 'someone-else', repo: 'unrelated', installationId: 1 }],
      permission: 'admin',
    });
    const logger = makeLogger();
    const result = await checkInstallationAdmin(
      { userId: 'u1', userToken: 't', repoUrl: REPO_URL },
      { lookup, logger },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-installation');
    expect(lookup.callCount.permission).toBe(0); // short-circuited before perm call
    expect(logger.entries[0]).toMatchObject({
      outcome: 'rejected-no-installation',
      stage: 'submission',
    });
  });

  test('T9-clean: no-installation and not-admin produce IDENTICAL safeMessage', async () => {
    // Two different rejections, same surface-level message.
    const noInstall = await checkInstallationAdmin(
      { userId: 'u1', userToken: 't', repoUrl: REPO_URL },
      {
        lookup: makeFakeLookup({ installations: [], permission: 'admin' }),
        logger: makeLogger(),
      },
    );
    const notAdmin = await checkInstallationAdmin(
      { userId: 'u1', userToken: 't', repoUrl: REPO_URL },
      {
        lookup: makeFakeLookup({
          installations: [{ owner: 'acme', repo: 'widgets', installationId: 1 }],
          permission: 'read',
        }),
        logger: makeLogger(),
      },
    );
    expect(noInstall.ok).toBe(false);
    expect(notAdmin.ok).toBe(false);
    if (!noInstall.ok && !notAdmin.ok) {
      expect(noInstall.safeMessage).toBe(notAdmin.safeMessage);
      // And neither leaks the internal reason code.
      expect(noInstall.safeMessage).not.toContain('no-installation');
      expect(notAdmin.safeMessage).not.toContain('not-admin');
      expect(notAdmin.safeMessage).not.toContain('read');
    }
  });

  test('revoked user token → rejected (token-invalid) with reauth message', async () => {
    const lookup = makeFakeLookup({ revokeToken: true });
    const logger = makeLogger();
    const result = await checkInstallationAdmin(
      { userId: 'u1', userToken: 't', repoUrl: REPO_URL },
      { lookup, logger },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('token-invalid');
      expect(result.safeMessage).toMatch(/reauthenticate/i);
    }
    expect(logger.entries[0]).toMatchObject({
      outcome: 'rejected-token-invalid',
      stage: 'submission',
    });
  });

  test('lookup-failed (5xx / network) fails closed', async () => {
    const lookup = makeFakeLookup({ failOnList: true });
    const logger = makeLogger();
    const result = await checkInstallationAdmin(
      { userId: 'u1', userToken: 't', repoUrl: REPO_URL },
      { lookup, logger },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('lookup-failed');
    expect(logger.entries[0]?.outcome).toBe('rejected-lookup-failed');
  });

  test('malformed repo URL is rejected before any lookup call', async () => {
    const lookup = makeFakeLookup({});
    const logger = makeLogger();
    const result = await checkInstallationAdmin(
      { userId: 'u1', userToken: 't', repoUrl: 'not a url' },
      { lookup, logger },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed-repo-url');
    expect(lookup.callCount.list).toBe(0);
    expect(logger.entries[0]?.outcome).toBe('rejected-malformed-repo-url');
  });

  test('case-insensitive repo match (Acme/Widgets vs acme/widgets)', async () => {
    const lookup = makeFakeLookup({
      installations: [{ owner: 'Acme', repo: 'Widgets', installationId: 5 }],
      permission: 'admin',
    });
    const result = await checkInstallationAdmin(
      { userId: 'u1', userToken: 't', repoUrl: 'https://github.com/acme/widgets' },
      { lookup, logger: makeLogger() },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.installationId).toBe(5);
  });

  test('logs stage=pr-open for the defense-in-depth re-check', async () => {
    const lookup = makeFakeLookup({
      installations: [{ owner: 'acme', repo: 'widgets', installationId: 99 }],
      permission: 'admin',
    });
    const logger = makeLogger();
    await checkInstallationAdmin(
      { userId: 'u1', userToken: 't', repoUrl: REPO_URL, stage: 'pr-open' },
      { lookup, logger },
    );
    expect(logger.entries[0]?.stage).toBe('pr-open');
  });

  test('app-revoked-between-submission-and-pr-open: stage=pr-open, outcome=rejected-no-installation', async () => {
    // Acceptance criterion 4: "App revoked between submission and PR-open
    // → PR creation re-checks (defense in depth)." Simulate by having the
    // lookup return an empty installations list at the pr-open stage.
    const lookup = makeFakeLookup({ installations: [], permission: 'admin' });
    const logger = makeLogger();
    const result = await checkInstallationAdmin(
      { userId: 'u1', userToken: 't', repoUrl: REPO_URL, stage: 'pr-open' },
      { lookup, logger },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-installation');
    expect(logger.entries[0]).toMatchObject({
      outcome: 'rejected-no-installation',
      stage: 'pr-open',
    });
  });

  test('logger is called exactly once per invocation', async () => {
    const lookup = makeFakeLookup({
      installations: [{ owner: 'acme', repo: 'widgets', installationId: 99 }],
      permission: 'admin',
    });
    const logger = makeLogger();
    await checkInstallationAdmin(
      { userId: 'u1', userToken: 't', repoUrl: REPO_URL },
      { lookup, logger },
    );
    expect(logger.entries).toHaveLength(1);
  });

  test('safeMessage NEVER contains the user token', async () => {
    const TOKEN_FIXTURE = 'ghp_supersecret-test-token-xyz';
    const lookup = makeFakeLookup({ revokeToken: true });
    const logger = makeLogger();
    const result = await checkInstallationAdmin(
      { userId: 'u1', userToken: TOKEN_FIXTURE, repoUrl: REPO_URL },
      { lookup, logger },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeMessage).not.toContain(TOKEN_FIXTURE);
    }
    for (const entry of logger.entries) {
      expect(JSON.stringify(entry)).not.toContain(TOKEN_FIXTURE);
    }
  });
});
