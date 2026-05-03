import * as crypto from 'crypto';
import { handleGithubAppWebhook } from '../webhooks';
import type {
  DeliveryDeduper,
  RunCanceller,
  TokenStore,
  WebhookLogEntry,
  WebhookLogger,
} from '../webhooks';

// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
// Test fixture only — used to compute HMAC signatures inside this test file.
// Per docs/SECURE_SDLC.md §6.1: rationale="test-only HMAC fixture, never read at runtime"
//   expires=2026-08-03 reviewer=CISO
const SECRET = 'test-webhook-secret-do-not-ship';

function signedHeaders(rawBody: Buffer, overrides: Record<string, string> = {}) {
  const sig = crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
  return {
    'x-github-event': 'installation',
    'x-github-delivery': 'delivery-1',
    'x-hub-signature-256': `sha256=${sig}`,
    ...overrides,
  };
}

function makeFakes() {
  const deletedAt = new Map<number, Date>();
  const deletedCount = new Map<number, number>();
  const cancelledCount = new Map<number, number>();
  const revokedUsers = new Set<number>();
  const seenDeliveries = new Set<string>();
  const logs: WebhookLogEntry[] = [];

  const tokens: TokenStore = {
    async deleteByInstallationId(id) {
      const prior = deletedCount.get(id) ?? 0;
      // Simulate two tokens (access + refresh) on the first delete only
      const removed = prior === 0 ? 2 : 0;
      deletedCount.set(id, prior + removed);
      deletedAt.set(id, new Date());
      return removed;
    },
    async markUserRevokedByInstallationId(id) {
      revokedUsers.add(id);
    },
    lastDeletedAt(id) {
      return deletedAt.get(id) ?? null;
    },
  };

  const runs: RunCanceller = {
    async cancelAllForInstallation(id) {
      const prior = cancelledCount.get(id) ?? 0;
      const cancelled = prior === 0 ? 3 : 0;
      cancelledCount.set(id, prior + cancelled);
      return cancelled;
    },
  };

  const dedup: DeliveryDeduper = {
    async hasSeenAndRecord(deliveryId) {
      if (seenDeliveries.has(deliveryId)) return true;
      seenDeliveries.add(deliveryId);
      return false;
    },
  };

  const logger: WebhookLogger = {
    log(entry) {
      logs.push(entry);
    },
  };

  return {
    tokens,
    runs,
    dedup,
    logger,
    state: { deletedCount, cancelledCount, revokedUsers, logs },
  };
}

describe('handleGithubAppWebhook', () => {
  test('signed installation.deleted purges tokens, marks user revoked, cancels runs', async () => {
    const body = Buffer.from(
      JSON.stringify({ action: 'deleted', installation: { id: 4242 } }),
    );
    const fakes = makeFakes();

    const res = await handleGithubAppWebhook(
      { rawBody: body, headers: signedHeaders(body) },
      { secret: SECRET, ...fakes },
    );

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fakes.state.deletedCount.get(4242)).toBe(2);
    expect(fakes.state.revokedUsers.has(4242)).toBe(true);
    expect(fakes.state.cancelledCount.get(4242)).toBe(3);

    // Log discipline (T10): exactly one entry, no raw-payload contents.
    // Allowed metadata: event, action, installationId, deliveryId, signed,
    // outcome, tokensDeleted, runsCancelled, reason. Any other key would
    // indicate the handler is leaking payload fields into logs.
    expect(fakes.state.logs).toHaveLength(1);
    const entry = fakes.state.logs[0];
    expect(entry.outcome).toBe('tokens-purged');
    expect(entry.installationId).toBe(4242);
    expect(entry.signed).toBe(true);
    expect(entry.tokensDeleted).toBe(2);
    expect(entry.runsCancelled).toBe(3);
    const allowedKeys = new Set([
      'event', 'action', 'installationId', 'deliveryId', 'signed',
      'outcome', 'tokensDeleted', 'runsCancelled', 'reason',
    ]);
    for (const k of Object.keys(entry)) {
      expect(allowedKeys.has(k)).toBe(true);
    }
  });

  test('unsigned and wrong-secret webhooks are rejected with no state change', async () => {
    const body = Buffer.from(
      JSON.stringify({ action: 'deleted', installation: { id: 99 } }),
    );

    // Case A — no signature header at all
    {
      const fakes = makeFakes();
      const res = await handleGithubAppWebhook(
        {
          rawBody: body,
          headers: { 'x-github-event': 'installation', 'x-github-delivery': 'd-a' },
        },
        { secret: SECRET, ...fakes },
      );
      expect(res.status).toBe(401);
      expect(fakes.state.deletedCount.get(99) ?? 0).toBe(0);
      expect(fakes.state.cancelledCount.get(99) ?? 0).toBe(0);
      expect(fakes.state.revokedUsers.has(99)).toBe(false);
      expect(fakes.state.logs[0].outcome).toBe('rejected-missing-header');
    }

    // Case B — signed with the wrong secret
    {
      const wrongSig = crypto.createHmac('sha256', 'not-the-real-secret').update(body).digest('hex');
      const fakes = makeFakes();
      const res = await handleGithubAppWebhook(
        {
          rawBody: body,
          headers: {
            'x-github-event': 'installation',
            'x-github-delivery': 'd-b',
            'x-hub-signature-256': `sha256=${wrongSig}`,
          },
        },
        { secret: SECRET, ...fakes },
      );
      expect(res.status).toBe(401);
      expect(fakes.state.deletedCount.get(99) ?? 0).toBe(0);
      expect(fakes.state.cancelledCount.get(99) ?? 0).toBe(0);
      expect(fakes.state.revokedUsers.has(99)).toBe(false);
      expect(fakes.state.logs[0].outcome).toBe('rejected-unsigned');
    }
  });

  test('replay of the same delivery id is idempotent — single execution, no double cancel', async () => {
    const body = Buffer.from(
      JSON.stringify({ action: 'deleted', installation: { id: 7 } }),
    );
    const fakes = makeFakes();
    const headers = signedHeaders(body, { 'x-github-delivery': 'replay-uuid' });

    const first = await handleGithubAppWebhook({ rawBody: body, headers }, { secret: SECRET, ...fakes });
    const second = await handleGithubAppWebhook({ rawBody: body, headers }, { secret: SECRET, ...fakes });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Tokens deleted exactly once even though we received the event twice.
    expect(fakes.state.deletedCount.get(7)).toBe(2);
    expect(fakes.state.cancelledCount.get(7)).toBe(3);

    expect(fakes.state.logs.map(l => l.outcome)).toEqual([
      'tokens-purged',
      'replay-ignored',
    ]);
  });

  test('24h SLA: token deletion happens within seconds, well inside §3.4 window', async () => {
    const body = Buffer.from(
      JSON.stringify({ action: 'deleted', installation: { id: 1234 } }),
    );
    const fakes = makeFakes();

    const startedAt = new Date();
    await handleGithubAppWebhook(
      { rawBody: body, headers: signedHeaders(body) },
      { secret: SECRET, ...fakes },
    );

    const deletedAt = fakes.tokens.lastDeletedAt!(1234);
    expect(deletedAt).not.toBeNull();
    const elapsedMs = deletedAt!.getTime() - startedAt.getTime();
    // Generous bound: must be under 5 seconds in tests, vs. the §3.4 24h SLA.
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
    expect(elapsedMs).toBeLessThan(5_000);

    // And: there is no surviving usable token state for this installation.
    // Re-running the deletion is a no-op (returns 0), proving the first
    // call left zero tokens behind.
    const second = await fakes.tokens.deleteByInstallationId(1234);
    expect(second).toBe(0);
  });

  test('installation_repositories.removed is treated as a revocation event', async () => {
    const body = Buffer.from(
      JSON.stringify({ action: 'removed', installation: { id: 555 } }),
    );
    const fakes = makeFakes();
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');

    const res = await handleGithubAppWebhook(
      {
        rawBody: body,
        headers: {
          'x-github-event': 'installation_repositories',
          'x-github-delivery': 'ir-1',
          'x-hub-signature-256': `sha256=${sig}`,
        },
      },
      { secret: SECRET, ...fakes },
    );

    expect(res.status).toBe(200);
    expect(fakes.state.deletedCount.get(555)).toBe(2);
    expect(fakes.state.cancelledCount.get(555)).toBe(3);
    expect(fakes.state.logs[0].outcome).toBe('tokens-purged');
  });

  test('unrelated event types are acked but no-op', async () => {
    const body = Buffer.from(JSON.stringify({ zen: 'Keep it logically awesome.' }));
    const fakes = makeFakes();
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');

    const res = await handleGithubAppWebhook(
      {
        rawBody: body,
        headers: {
          'x-github-event': 'ping',
          'x-github-delivery': 'ping-1',
          'x-hub-signature-256': `sha256=${sig}`,
        },
      },
      { secret: SECRET, ...fakes },
    );

    expect(res.status).toBe(200);
    expect(fakes.state.logs[0].outcome).toBe('no-op');
    expect(fakes.state.deletedCount.size).toBe(0);
    expect(fakes.state.cancelledCount.size).toBe(0);
  });

  test('signature must be computed over the exact raw bytes, not a re-stringification', async () => {
    // GitHub-style payload; we tamper with the body after computing sig.
    const original = Buffer.from(
      JSON.stringify({ action: 'deleted', installation: { id: 1 } }),
    );
    const tampered = Buffer.from(
      JSON.stringify({ action: 'deleted', installation: { id: 999 } }),
    );
    const sig = crypto.createHmac('sha256', SECRET).update(original).digest('hex');
    const fakes = makeFakes();

    const res = await handleGithubAppWebhook(
      {
        rawBody: tampered,
        headers: {
          'x-github-event': 'installation',
          'x-github-delivery': 'tamper-1',
          'x-hub-signature-256': `sha256=${sig}`,
        },
      },
      { secret: SECRET, ...fakes },
    );

    expect(res.status).toBe(401);
    expect(fakes.state.deletedCount.size).toBe(0);
  });
});
