// Storage/effect ports for the v1 DoS + cost-burn guards (MAL-48 / T11/T12/O2).
//
// All guard logic is pure — anything that touches a clock, a counter store, an
// alert channel, or wall-clock time goes through these interfaces. That gives
// us two things:
//   1. A single in-memory implementation backs unit tests + the local CLI run.
//   2. The same guard code drops into the future HTTP ingress and a real
//      Postgres/Redis-backed store in prod without conditional branching.

export interface Clock {
  now(): Date;
}

export interface RateLimitStore {
  // Number of pipeline starts recorded for `userId` at or after `since`.
  // The store does NOT have to be exact under high concurrency — over-counts
  // are fine (fail-closed); under-counts would break the limit, so the store
  // implementation must be at least as conservative as a single-writer log.
  countSince(userId: string, since: Date): Promise<number>;

  // Atomically record one pipeline start at `at`. Idempotency is the caller's
  // job (the limiter only calls this after `tryStart` says ok) — recording
  // the same logical start twice would double-count against the user.
  recordStart(userId: string, at: Date): Promise<void>;
}

export interface SpendStore {
  // Aggregate Anthropic spend (USD) for `tenantId` over [since, now]. Same
  // bounded-staleness contract as the rate-limit store: implementations may
  // over-report (fail-closed), never under-report.
  getTenantSpend(tenantId: string, since: Date): Promise<number>;

  // Aggregate global Anthropic spend (USD) over [since, now].
  getGlobalSpend(since: Date): Promise<number>;

  // Record a single LLM call's spend. Tenant + global counters are updated
  // together so the next read across both is consistent.
  recordSpend(tenantId: string, usd: number, at: Date): Promise<void>;
}

export interface Alerter {
  // Fire-and-forget alert. Implementations route to PagerDuty / Slack /
  // email per the §3 incident response playbook. The guard layer must not
  // block on this — `fire` is intentionally void, not a Promise.
  fire(level: AlertLevel, payload: AlertPayload): void;
}

export type AlertLevel = 'warn' | 'critical';

export interface AlertPayload {
  // Stable, human-readable code so the alert routing rules can match on it
  // without parsing the message. Example: 'cost-tenant-daily-warn',
  // 'cost-global-monthly-tripped'.
  code: string;
  message: string;
  tenantId?: string;
  current?: number;
  limit?: number;
}

export type UserRole = 'admin' | 'user';
