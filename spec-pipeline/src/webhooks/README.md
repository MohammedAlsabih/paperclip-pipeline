# GitHub App-uninstall webhook handler

Implements MAL-46 / threat-model T16 / open-item O3.

When a customer revokes our access (uninstalls the GitHub App, removes
repositories from the install, or revokes the OAuth grant), `SECURITY_POLICY.md`
§3.4 commits us to deleting their tokens within **24 hours** and to stopping
any in-flight pipeline work that would otherwise act on their behalf after
they thought they revoked us.

## What this module is

A pure, framework-agnostic handler:

```ts
handleGithubAppWebhook(
  { rawBody: Buffer, headers: { ... } },
  { secret, tokens, runs, dedup, logger, clock? },
) → Promise<{ status, body }>
```

The HTTP framework (Express, Fastify, Fly handler — TBD) is responsible for
two things: (a) handing us the **raw body bytes** GitHub sent (NOT a
re-stringified JSON; HMAC verifies the exact bytes) and (b) translating the
returned `status` to an HTTP response.

The handler does:

1. **HMAC verify** — `X-Hub-Signature-256` against the configured secret,
   constant-time. Anything missing/malformed/mismatched → 401 before parse.
2. **JSON parse** — malformed body after a valid signature → 400.
3. **Replay dedupe** — `X-GitHub-Delivery` UUID is recorded; second arrival
   short-circuits to 200 with `replay-ignored`.
4. **Dispatch** — only `installation.deleted` and
   `installation_repositories.removed` trigger revocation. Everything else
   (ping, push, …) is acked + no-op so GitHub stops retrying.
5. **Revoke** — delete tokens → mark user revoked → cancel queued + running
   pipeline runs. Order matters: tokens first, so any concurrent worker
   that re-loads creds fails closed.
6. **Log** — exactly one entry per delivery with whitelisted fields only:
   `event`, `action`, `installationId`, `deliveryId`, `signed`, `outcome`,
   `tokensDeleted`, `runsCancelled`, `reason`. Raw payload is never logged
   (T10 — sensitive-data-in-logs).

## What this module is **not**

- Not an HTTP server. Mounting on a route is the caller's job.
- Not a DB layer. `TokenStore` / `RunCanceller` / `DeliveryDeduper` are
  ports — production wires them to SQLite-on-Fly per ADR-004; tests use
  the in-memory fakes in `__tests__/github-app-webhook.test.ts`.
- Not a GitHub App registration. The App must exist, the webhook URL
  must be set, and the secret must match what's in Fly secrets.

## Production wiring — pending work

Tracked separately so this PR stays small enough to security-review. None
of the items below ship as part of MAL-46:

| Item | Owner | Tracked under |
| --- | --- | --- |
| Provision the GitHub App (App ID, private key, webhook URL) | CTO | follow-up child issue on MAL-4 |
| Stand up the customer-facing API service that exposes `POST /webhooks/github` and feeds `rawBody` into this handler | CTO | follow-up child issue on MAL-4 |
| Real `TokenStore` adapter against the SQLite users/installations tables (per ADR-004) | CTO | depends on auth schema landing |
| Real `RunCanceller` adapter against pipeline run state (queued in Paperclip; running on Fly) | CTO | depends on pipeline runner extracted from `pipeline/run.ts` |
| Persistent `DeliveryDeduper` (the in-memory `Set` is fine for tests but loses state on deploy → replay window opens) | CTO | same DB as token store |
| `WEBHOOK_SECRET` set as a Fly secret (P0 — never in repo, never in `.env.example`) | CTO + CISO | ops checklist |

## Security review (per issue MAL-46)

This PR touches three of the §3 sensitive surfaces (auth, customer data,
third-party trust). The CISO must comment `SECURITY-APPROVED ✅` on the
implementation PR before merge. Specific things to scrutinise:

- HMAC verify uses `crypto.timingSafeEqual` and rejects on length mismatch
  before compare. Hex-only regex on the provided digest closes off any
  byte-count-via-error-message side channel.
- Token deletion runs **before** run cancellation, so a partial failure
  still satisfies §3.4 (workers will fail closed on next token load).
- Log entries are typed (`WebhookLogEntry`) and the test asserts that no
  key beyond the whitelist appears — adding a new field to the entry is
  visible in the diff and triggers the test, which is the intended gate.
- `installation.suspend` is **not** treated as revocation (suspension is
  reversible by the customer). If the policy interpretation says
  suspension should also purge tokens, that's a separate decision the
  CISO owns.

## Tests

`spec-pipeline/src/__tests__/github-app-webhook.test.ts` covers the four
scenarios called out in MAL-46:

1. Signed `installation.deleted` happy path → tokens purged, runs cancelled.
2. Unsigned + wrong-secret webhooks → 401, no state change.
3. Replay (same `X-GitHub-Delivery`) → idempotent, single execution.
4. 24h SLA → deletion observed within seconds; second delete returns 0
   (proving zero surviving tokens for that installation).

Plus three defence-in-depth tests: `installation_repositories.removed`,
no-op on unrelated events, body-tamper rejection.
