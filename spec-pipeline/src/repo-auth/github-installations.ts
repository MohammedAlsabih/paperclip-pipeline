// Live GitHub adapter for `InstallationLookup`. Backs the admin-validation
// guard with real github.com API calls. The user-facing pure validator in
// `installation-admin.ts` does not depend on `fetch` or any of the URL
// shapes here — this file is the only place those concerns live.

import fetch from 'node-fetch';
import {
  InstallationLookup,
  InstalledRepo,
  RepoPermission,
  RepoRef,
  TokenRevokedError,
} from './types';

const GITHUB_API = 'https://api.github.com';
const ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';

interface InstallationsListResponse {
  installations?: { id?: number }[];
}

interface InstallationReposResponse {
  repositories?: { owner?: { login?: string }; name?: string }[];
}

interface PermissionResponse {
  permission?: string;
}

function authHeaders(userToken: string): Record<string, string> {
  return {
    Accept: ACCEPT,
    Authorization: `Bearer ${userToken}`,
    'X-GitHub-Api-Version': API_VERSION,
  };
}

// Normalize the freeform `permission` string GitHub returns into our enum.
// Anything we don't recognize is treated as `none` — fail-closed so a future
// GitHub-introduced permission level (e.g. a new bucket between read and
// triage) doesn't accidentally satisfy ADMIN_PERMISSIONS.
function normalizePermission(raw: string | undefined): RepoPermission {
  switch (raw) {
    case 'admin':
    case 'maintain':
    case 'write':
    case 'triage':
    case 'read':
    case 'none':
      return raw;
    default:
      return 'none';
  }
}

export interface GithubInstallationsAdapterOptions {
  // Override for tests — defaults to global node-fetch.
  fetchImpl?: typeof fetch;
  // Override for tests — defaults to api.github.com.
  apiBase?: string;
  // Page size for the installations listing. GitHub max is 100. We keep
  // small to bound the worst-case spend on listing — a human user rarely
  // has more than 30 installations across orgs.
  perPage?: number;
}

export class GithubInstallationsAdapter implements InstallationLookup {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly perPage: number;

  constructor(opts: GithubInstallationsAdapterOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = opts.apiBase ?? GITHUB_API;
    this.perPage = opts.perPage ?? 30;
  }

  async listUserInstallations(userToken: string): Promise<InstalledRepo[]> {
    const installationsUrl = `${this.apiBase}/user/installations?per_page=${this.perPage}`;
    const installations = await this.getJson<InstallationsListResponse>(
      installationsUrl,
      userToken,
    );

    const out: InstalledRepo[] = [];
    for (const inst of installations.installations ?? []) {
      const id = typeof inst.id === 'number' ? inst.id : null;
      if (id === null) continue;
      const reposUrl = `${this.apiBase}/user/installations/${id}/repositories?per_page=${this.perPage}`;
      const repos = await this.getJson<InstallationReposResponse>(reposUrl, userToken);
      for (const r of repos.repositories ?? []) {
        const owner = r.owner?.login;
        const name = r.name;
        if (typeof owner === 'string' && typeof name === 'string') {
          out.push({ owner, repo: name, installationId: id });
        }
      }
    }
    return out;
  }

  async getUserRepoPermission(userToken: string, repo: RepoRef): Promise<RepoPermission> {
    // We rely on the requesting user's own identity. GitHub's "get
    // collaborator permission" endpoint requires `?username=`, which we'd
    // have to look up first via `/user`. We chain those two calls here.
    const meUrl = `${this.apiBase}/user`;
    const me = await this.getJson<{ login?: string }>(meUrl, userToken);
    const login = me.login;
    if (typeof login !== 'string' || login.length === 0) {
      // No username on the token's identity → treat as token-invalid; the
      // user OAuth scope must include at least `read:user` for this check
      // to work, and a missing login indicates a misissued token.
      throw new TokenRevokedError('no-login-on-token');
    }
    const permUrl = `${this.apiBase}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/collaborators/${encodeURIComponent(login)}/permission`;
    const perm = await this.getJson<PermissionResponse>(permUrl, userToken);
    return normalizePermission(perm.permission);
  }

  private async getJson<T>(url: string, userToken: string): Promise<T> {
    const res = await this.fetchImpl(url, { headers: authHeaders(userToken) });
    if (res.status === 401) {
      throw new TokenRevokedError('401-unauthorized');
    }
    if (!res.ok) {
      // 403 from /collaborators/.../permission means the user has no access.
      // We surface this as `permission=none` rather than an error so the
      // pure validator can treat it as a normal not-admin rejection.
      if (res.status === 403 && url.endsWith('/permission')) {
        return { permission: 'none' } as unknown as T;
      }
      // 404 on /collaborators/.../permission also indicates no access.
      if (res.status === 404 && url.includes('/collaborators/')) {
        return { permission: 'none' } as unknown as T;
      }
      const bodyText = await res.text().catch(() => '');
      throw new Error(`GitHub API GET ${url} → ${res.status}: ${bodyText.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }
}
