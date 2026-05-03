import { pickSignatureHeader, verifyGithubSignature } from './signature';
import type {
  Clock,
  DeliveryDeduper,
  RunCanceller,
  TokenStore,
  WebhookLogger,
} from './types';

const EVENT_HEADER = 'x-github-event';
const DELIVERY_HEADER = 'x-github-delivery';

export type WebhookStatus = 200 | 202 | 400 | 401;

export interface WebhookResponse {
  status: WebhookStatus;
  body: { ok: boolean; reason?: string };
}

export interface HandlerDeps {
  secret: string;
  tokens: TokenStore;
  runs: RunCanceller;
  dedup: DeliveryDeduper;
  logger: WebhookLogger;
  clock?: Clock;
}

export interface HandlerInput {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

interface InstallationPayload {
  action?: string;
  installation?: { id?: number };
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = headers[name];
  const upper = headers[name.toUpperCase()];
  const raw = lower ?? upper;
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

// Pure entry point. The HTTP framework (Express/Fastify/Fly handler) is
// responsible for handing us the raw body buffer (NOT a re-stringified JSON
// — the signature is computed over the exact bytes GitHub sent). We return
// a status + minimal body, plus we record exactly one log entry per call.
//
// Logging contract (see types.WebhookLogEntry): we never write the raw body
// or any payload field beyond installation ID. Even on parse failure, the
// log line carries event/delivery/outcome only.
export async function handleGithubAppWebhook(
  input: HandlerInput,
  deps: HandlerDeps,
): Promise<WebhookResponse> {
  const { rawBody, headers } = input;
  const event = pickHeader(headers, EVENT_HEADER) ?? 'unknown';
  const deliveryId = pickHeader(headers, DELIVERY_HEADER);
  const signatureHeader = pickSignatureHeader(headers);

  // Step 1 — verify HMAC. Anything that doesn't match the secret is rejected
  // before we even parse the body. (T2 — webhook spoofing.)
  const verify = verifyGithubSignature(rawBody, deps.secret, signatureHeader);
  if (!verify.ok) {
    const outcome =
      verify.reason === 'missing-header'
        ? 'rejected-missing-header'
        : verify.reason === 'empty-secret'
          ? 'rejected-no-secret'
          : verify.reason === 'malformed-header'
            ? 'rejected-malformed'
            : 'rejected-unsigned';
    deps.logger.log({
      event,
      deliveryId,
      signed: false,
      outcome,
      reason: verify.reason,
    });
    return { status: 401, body: { ok: false, reason: 'invalid-signature' } };
  }

  // Step 2 — parse JSON body. We've authenticated the source, but malformed
  // JSON is still a 400 (no state change).
  let payload: InstallationPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf-8')) as InstallationPayload;
  } catch {
    deps.logger.log({
      event,
      deliveryId,
      signed: true,
      outcome: 'rejected-malformed',
      reason: 'json-parse',
    });
    return { status: 400, body: { ok: false, reason: 'malformed-body' } };
  }

  const action = payload.action;
  const installationId =
    typeof payload.installation?.id === 'number' ? payload.installation.id : undefined;

  // Step 3 — idempotency. GitHub will retry deliveries; same delivery ID
  // means same logical event. Dedupe so two arrivals don't double-cancel
  // runs or double-log a deletion (T-replay).
  if (deliveryId) {
    const seen = await deps.dedup.hasSeenAndRecord(deliveryId);
    if (seen) {
      deps.logger.log({
        event,
        action,
        installationId,
        deliveryId,
        signed: true,
        outcome: 'replay-ignored',
      });
      return { status: 200, body: { ok: true, reason: 'replay-ignored' } };
    }
  }

  // Step 4 — dispatch. We only act on the two events the issue calls out.
  // Anything else (ping, push, …) is logged and acked so GitHub stops
  // retrying, but we don't touch tokens or runs.
  const isUninstall = event === 'installation' && action === 'deleted';
  const isReposRemoved = event === 'installation_repositories' && action === 'removed';

  if (!isUninstall && !isReposRemoved) {
    deps.logger.log({
      event,
      action,
      installationId,
      deliveryId,
      signed: true,
      outcome: 'no-op',
    });
    return { status: 200, body: { ok: true } };
  }

  if (installationId === undefined) {
    deps.logger.log({
      event,
      action,
      deliveryId,
      signed: true,
      outcome: 'rejected-malformed',
      reason: 'missing-installation-id',
    });
    return { status: 400, body: { ok: false, reason: 'missing-installation-id' } };
  }

  // Step 5 — execute the revocation. Order matters:
  //   1. delete tokens first so any in-flight worker that re-loads creds
  //      cannot continue acting on the customer's behalf
  //   2. mark the user revoked (DB invariant)
  //   3. cancel queued + running pipeline runs
  // If step 3 fails after step 1 succeeded, we still satisfy the §3.4 24h
  // SLA — the runs will fail closed when they next try to use a token.
  const tokensDeleted = await deps.tokens.deleteByInstallationId(installationId);
  await deps.tokens.markUserRevokedByInstallationId(installationId);
  const runsCancelled = await deps.runs.cancelAllForInstallation(installationId);

  deps.logger.log({
    event,
    action,
    installationId,
    deliveryId,
    signed: true,
    outcome: 'tokens-purged',
    tokensDeleted,
    runsCancelled,
  });

  return { status: 200, body: { ok: true } };
}
