# Secure SDLC

> **Ownership.** The CISO owns this document. Sections §1–§5 and §7+ are CISO-authored
> policy. Sections **§6 (AppSec tooling baseline)**, **§6.1 (Allowlist hygiene)**, and
> **§6.2 (Branch protection)** were drafted by the CTO under MAL-38 to describe the
> tooling that is wired into the PR pipeline today. The CISO reviews and signs off on
> the rule packs and any allowlist entry before changes merge.

<!-- §1–§5: CISO-owned. Stubs intentionally omitted until CISO publishes. -->

## §6 — AppSec tooling baseline

Every PR against `main` runs three scanners as required GitHub Actions checks. Each
gate is enforced in `.github/workflows/security.yml`. None of the scanners can be
bypassed without an explicit allowlist entry that meets §6.1.

| Scanner | Tool | Where it runs | Gate (blocks merge when…) |
| --- | --- | --- | --- |
| Secrets | [Gitleaks](https://github.com/gitleaks/gitleaks) `v8` | pre-commit (`.pre-commit-config.yaml`) + CI (`secrets-scan` job) | any P0 finding (default ruleset) that is not allowlisted under §6.1 |
| Dependencies | `npm audit --audit-level=high` + GitHub Dependabot | CI (`dependency-scan` job, matrix over `/` and `/spec-pipeline`) + automated PRs | any high/critical with no patch path. Patched-but-not-yet-upgraded findings open an issue with the SLA from `SECURITY_POLICY.md` §7.1. |
| SAST | [Semgrep](https://semgrep.dev) `1.95.0` with `p/typescript`, `p/javascript`, `p/owasp-top-ten`, `p/nodejs`, `p/nodejsscan` | CI (`sast-scan` job) | any rule fired at `ERROR` severity ("critical"). `WARNING`-severity findings open an issue and are assigned to the PR author. |

Engineer local setup (one-time):

```bash
# Install pre-commit (Python)
pip install --user pre-commit

# Install the hooks defined in .pre-commit-config.yaml
pre-commit install

# (optional) Run all hooks against the full repo right now
pre-commit run --all-files
```

After that, every `git commit` runs Gitleaks against staged content. CI re-runs the
same scan on every PR; pre-commit is fast feedback, CI is the gate.

### §6.1 — Allowlist hygiene

The same four rules apply to **every** suppression mechanism — Gitleaks
(`.gitleaks.toml [allowlist]`) and Semgrep (`// nosemgrep:` inline comments or
`.semgrepignore`). New entries are P0 unless they satisfy all four:

1. **Justification.** A `reason="…"` (or `description`) explaining why the value is
   not a real finding (test fixture, documentation placeholder, vendored dummy token).
2. **Expiry.** A co-located `expires=YYYY-MM-DD` token. CI fails the build the day
   after expiry until the entry is renewed (with fresh CISO sign-off) or removed.
   - Gitleaks: enforced by the `allowlist-hygiene` CI job.
   - Semgrep: reviewed during the CISO's quarterly suppression sweep
     (the `expires=` token is required so the sweep can grep for stale entries).
3. **CISO sign-off.** New entries (and renewals) require the CISO to approve the PR.
   Link the approval in the PR description.
4. **In-source breadcrumb.** The file containing the suppressed string includes an
   inline comment next to the value, so a reader of that file knows it was reviewed:
   - Gitleaks: `# gitleaks:allow expires=YYYY-MM-DD reason="<short reason>"`
   - Semgrep: `// nosemgrep: <rule-id>` followed by a comment with
     `expires=YYYY-MM-DD reason="<short reason>" reviewer=CISO`

Anything that doesn't meet all four is treated as a P0 finding and blocks merge.

### §6.2 — Branch protection on `main`

`main` is protected. Required status checks (must all pass before merge):

- `CI / spec-pipeline (typecheck + test)` (existing)
- `security / Gitleaks (secrets)` (new — §6)
- `security / Gitleaks allowlist hygiene` (new — §6.1)
- `security / npm audit (deps)` (new — §6, matrix entries for both workspaces)
- `security / Semgrep (SAST)` (new — §6)

Additional rules:

- Require a pull request before merging.
- Require approval from at least one CODEOWNER.
- Dismiss stale approvals when new commits are pushed.
- Require linear history.
- Disallow force pushes and deletions.

> **Operator action — pending.** Branch protection is a GitHub repo setting that is not
> in the repo. The repo owner must enable the rules above under
> Settings → Branches → Branch protection rules → `main` after this PR merges. CTO
> will follow up with the CISO once the new check names appear in the dropdown
> (they only show up after the workflow has run at least once).

<!-- §7+: CISO-owned. -->
