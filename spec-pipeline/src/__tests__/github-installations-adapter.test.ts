// Adapter contract tests for GithubInstallationsAdapter (MAL-47). Uses an
// in-memory fake fetch so we don't hit api.github.com from CI; we verify
// the adapter calls the right URLs, sends the right headers, normalizes
// permissions correctly, and converts 401 → TokenRevokedError.

import { Response } from 'node-fetch';
import {
  GithubInstallationsAdapter,
  TokenRevokedError,
} from '../repo-auth';

interface MockCall {
  url: string;
  headers: Record<string, string>;
}

interface MockOptions {
  // map URL → response. Each value can be a status+JSON pair or a function
  // that returns one (so we can model 401-on-second-call etc).
  responses: Record<
    string,
    { status: number; body: unknown } | (() => { status: number; body: unknown })
  >;
}

function makeFetch(opts: MockOptions): {
  fetchImpl: (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const fetchImpl = async (
    url: string,
    init?: { headers?: Record<string, string> },
  ): Promise<Response> => {
    calls.push({ url, headers: init?.headers ?? {} });
    const matchKey = Object.keys(opts.responses).find((k) => url.startsWith(k));
    if (!matchKey) {
      return new Response(JSON.stringify({ error: 'no-mock' }), { status: 500 });
    }
    const entry = opts.responses[matchKey];
    const resolved = typeof entry === 'function' ? entry() : entry;
    return new Response(JSON.stringify(resolved.body), {
      status: resolved.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    fetchImpl: fetchImpl as unknown as (
      url: string,
      init?: { headers?: Record<string, string> },
    ) => Promise<Response>,
    calls,
  };
}

const API_BASE = 'https://api.github.com';

describe('GithubInstallationsAdapter', () => {
  test('listUserInstallations returns flattened owner/repo/installationId triples', async () => {
    const { fetchImpl, calls } = makeFetch({
      responses: {
        [`${API_BASE}/user/installations?`]: {
          status: 200,
          body: { installations: [{ id: 1 }, { id: 2 }] },
        },
        [`${API_BASE}/user/installations/1/repositories`]: {
          status: 200,
          body: {
            repositories: [
              { owner: { login: 'acme' }, name: 'widgets' },
              { owner: { login: 'acme' }, name: 'gadgets' },
            ],
          },
        },
        [`${API_BASE}/user/installations/2/repositories`]: {
          status: 200,
          body: { repositories: [{ owner: { login: 'beta' }, name: 'app' }] },
        },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new GithubInstallationsAdapter({ fetchImpl: fetchImpl as any });
    const result = await adapter.listUserInstallations('user-token');
    expect(result).toEqual([
      { owner: 'acme', repo: 'widgets', installationId: 1 },
      { owner: 'acme', repo: 'gadgets', installationId: 1 },
      { owner: 'beta', repo: 'app', installationId: 2 },
    ]);
    // Bearer token sent on every call.
    for (const call of calls) {
      expect(call.headers.Authorization).toBe('Bearer user-token');
      expect(call.headers.Accept).toBe('application/vnd.github+json');
      expect(call.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    }
  });

  test('listUserInstallations: 401 throws TokenRevokedError', async () => {
    const { fetchImpl } = makeFetch({
      responses: {
        [`${API_BASE}/user/installations?`]: { status: 401, body: { message: 'Bad creds' } },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new GithubInstallationsAdapter({ fetchImpl: fetchImpl as any });
    await expect(adapter.listUserInstallations('rev')).rejects.toBeInstanceOf(
      TokenRevokedError,
    );
  });

  test('getUserRepoPermission: looks up login then permission, normalizes string', async () => {
    const { fetchImpl } = makeFetch({
      responses: {
        [`${API_BASE}/user`]: { status: 200, body: { login: 'octocat' } },
        [`${API_BASE}/repos/acme/widgets/collaborators/octocat/permission`]: {
          status: 200,
          body: { permission: 'admin' },
        },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new GithubInstallationsAdapter({ fetchImpl: fetchImpl as any });
    const perm = await adapter.getUserRepoPermission('t', { owner: 'acme', repo: 'widgets' });
    expect(perm).toBe('admin');
  });

  test('getUserRepoPermission: 403 on /permission means user has no access (returns "none")', async () => {
    const { fetchImpl } = makeFetch({
      responses: {
        [`${API_BASE}/user`]: { status: 200, body: { login: 'octocat' } },
        [`${API_BASE}/repos/acme/widgets/collaborators/octocat/permission`]: {
          status: 403,
          body: { message: 'Forbidden' },
        },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new GithubInstallationsAdapter({ fetchImpl: fetchImpl as any });
    const perm = await adapter.getUserRepoPermission('t', { owner: 'acme', repo: 'widgets' });
    expect(perm).toBe('none');
  });

  test('getUserRepoPermission: 404 on /collaborators path means no access (returns "none")', async () => {
    const { fetchImpl } = makeFetch({
      responses: {
        [`${API_BASE}/user`]: { status: 200, body: { login: 'octocat' } },
        [`${API_BASE}/repos/acme/widgets/collaborators/octocat/permission`]: {
          status: 404,
          body: { message: 'Not Found' },
        },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new GithubInstallationsAdapter({ fetchImpl: fetchImpl as any });
    const perm = await adapter.getUserRepoPermission('t', { owner: 'acme', repo: 'widgets' });
    expect(perm).toBe('none');
  });

  test('getUserRepoPermission: 401 on /user throws TokenRevokedError', async () => {
    const { fetchImpl } = makeFetch({
      responses: {
        [`${API_BASE}/user`]: { status: 401, body: { message: 'Bad creds' } },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new GithubInstallationsAdapter({ fetchImpl: fetchImpl as any });
    await expect(
      adapter.getUserRepoPermission('rev', { owner: 'acme', repo: 'widgets' }),
    ).rejects.toBeInstanceOf(TokenRevokedError);
  });

  test('getUserRepoPermission: missing login on /user is treated as token-invalid', async () => {
    const { fetchImpl } = makeFetch({
      responses: {
        [`${API_BASE}/user`]: { status: 200, body: {} },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new GithubInstallationsAdapter({ fetchImpl: fetchImpl as any });
    await expect(
      adapter.getUserRepoPermission('t', { owner: 'acme', repo: 'widgets' }),
    ).rejects.toBeInstanceOf(TokenRevokedError);
  });

  test('unknown permission string is normalized to "none" (fail-closed)', async () => {
    // Hypothetical future GitHub permission level we don't recognize.
    const { fetchImpl } = makeFetch({
      responses: {
        [`${API_BASE}/user`]: { status: 200, body: { login: 'octocat' } },
        [`${API_BASE}/repos/acme/widgets/collaborators/octocat/permission`]: {
          status: 200,
          body: { permission: 'super-duper-admin-of-the-future' },
        },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new GithubInstallationsAdapter({ fetchImpl: fetchImpl as any });
    const perm = await adapter.getUserRepoPermission('t', { owner: 'acme', repo: 'widgets' });
    expect(perm).toBe('none');
  });
});
