# paperclip-pipeline

Spec-to-PR pipeline for the Paperclip v1 demo. The pipeline ingests a spec, proposes
an architecture, generates code, opens a PR against a target repo, and posts a review
summary. See `spec-pipeline/` for the implementation and `docs/spec-format.md` for the
spec schema.

## Quick start

```bash
npm ci
npm test           # runs spec-pipeline tests via Jest
npm run typecheck  # tsc --noEmit at the root
```

## Security tooling — required local setup

Every engineer runs the same secrets scanner that CI runs, locally on every commit.
This is required by [`docs/SECURE_SDLC.md`](docs/SECURE_SDLC.md) §6.

```bash
# 1. Install pre-commit (Python — once per machine)
pip install --user pre-commit

# 2. Install the git hooks defined in .pre-commit-config.yaml
pre-commit install

# 3. (optional) Run against the whole repo right now
pre-commit run --all-files
```

After step 2, `git commit` will run Gitleaks against staged content and abort the
commit if it fires. If you believe a finding is a false positive, do **not** weaken
the rule — instead, follow the allowlist hygiene rules in
[`docs/SECURE_SDLC.md`](docs/SECURE_SDLC.md) §6.1 (CISO sign-off + expiry + in-source
breadcrumb).

The full AppSec gate set (Gitleaks, `npm audit`, Semgrep) runs on every PR via
`.github/workflows/security.yml`. Branch protection on `main` requires those checks
to pass — see `docs/SECURE_SDLC.md` §6.2.

## Repo layout

- `spec-pipeline/` — the pipeline modules (parser, repo-context extractor,
  architecture-proposer, code-generator, pr-creator, review-summary, e2e wiring).
- `docs/` — spec format, secure SDLC.
- `.github/workflows/` — CI (`ci.yml`) and security (`security.yml`).
- `.pre-commit-config.yaml` — pre-commit hooks (Gitleaks).
- `.gitleaks.toml` — Gitleaks rules + allowlist.
- `.github/dependabot.yml` — Dependabot config for npm + GitHub Actions.

The `demo-app/` and `paperclip-demo-target/` directories are checked out locally for
convenience but live in their own repos and are gitignored here.
