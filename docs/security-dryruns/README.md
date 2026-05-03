# Security tooling dry-run — paperclip-pipeline

Date: 2026-05-03
Operator: CTO (agent 68d18482)
Issue: MAL-38

All three scanners ran locally against the working tree, using the same
configurations and rule packs as `.github/workflows/security.yml`. Logs in this
directory.

## Summary

| Scanner | Config | Rules | Files | Findings | Gate result |
| --- | --- | --- | --- | --- | --- |
| Gitleaks v8.21.2 | `.gitleaks.toml` (extends default) | upstream defaults | 5 commits + working tree | 0 leaks | **PASS** |
| `npm audit --audit-level=high` (root) | `package.json` | n/a | n/a | 4 moderate (below gate) | **PASS** |
| `npm audit --audit-level=high` (spec-pipeline) | `spec-pipeline/package.json` | n/a | n/a | 0 vulns | **PASS** |
| Semgrep 1.95.0 — ERROR severity | `p/typescript p/javascript p/owasp-top-ten p/nodejs p/nodejsscan` | 99 rules | 57 files | 0 findings | **PASS** |
| Semgrep 1.95.0 — all severities | same | 215 rules | 57 files | 1 WARNING (test fixture, opens issue) | informational |

The Semgrep ERROR-severity gate passed after one inline `nosemgrep` suppression
applied to a test-only HMAC fixture in
`spec-pipeline/src/__tests__/github-app-webhook.test.ts:14` per `docs/SECURE_SDLC.md`
§6.1 hygiene rules. The remaining WARNING-severity finding (`node_username` rule
firing on a Router template literal in `repo-context.test.ts`) is the documented
"high finding opens an issue and assigns to author" case and is not a merge blocker.

## Logs

- `gitleaks.log` — both `--source` (git history) and `--no-git` (working tree) scans.
- `npm-audit.log` — root + spec-pipeline runs at `--audit-level=high`.
- `semgrep.log` — final ERROR-severity gate scan (the one CI uses to block).
- `semgrep-all-severities.log` — informational scan showing what would surface as
  follow-up issues at WARNING severity.

## Reproducing locally

```bash
# Gitleaks
docker run --rm -v "$PWD":/repo -w /repo zricethezav/gitleaks:v8.21.2 \
  detect --source /repo --config /repo/.gitleaks.toml --redact --no-banner

# npm audit
npm audit --audit-level=high
(cd spec-pipeline && npm audit --audit-level=high)

# Semgrep (ERROR-severity gate — what CI blocks on)
docker run --rm -v "$PWD":/repo -w /repo --user root semgrep/semgrep:1.95.0 \
  semgrep --config p/typescript --config p/javascript --config p/owasp-top-ten \
          --config p/nodejs --config p/nodejsscan \
          --severity=ERROR --error --metrics=off \
          --exclude=node_modules --exclude=demo-app --exclude=paperclip-demo-target \
          --exclude=dist --exclude=coverage --exclude=docs/security-dryruns /repo
```
