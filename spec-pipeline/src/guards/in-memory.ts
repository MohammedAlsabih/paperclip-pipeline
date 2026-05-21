// In-memory implementations of the guard ports. Used by the local CLI run
// and as fakes in unit tests. These are NOT suitable for prod — a single
// Fly machine restart wipes the counters and an attacker who can trigger
// restarts could reset their rate-limit clock. Prod uses the same interfaces
// backed by Postgres/Redis.

import type { Alerter, AlertLevel, AlertPayload, Clock, RateLimitStore, SpendStore } from './types';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(at: Date): void {
    this.current = at;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class InMemoryRateLimitStore implements RateLimitStore {
  // Per-user list of start timestamps. We never prune — for v1 the volume
  // is tiny (one process, ~tens of users). A real impl runs a sweep.
  private starts = new Map<string, Date[]>();

  async countSince(userId: string, since: Date): Promise<number> {
    const list = this.starts.get(userId) ?? [];
    return list.filter((d) => d.getTime() >= since.getTime()).length;
  }

  async recordStart(userId: string, at: Date): Promise<void> {
    const list = this.starts.get(userId) ?? [];
    list.push(at);
    this.starts.set(userId, list);
  }
}

export class InMemorySpendStore implements SpendStore {
  // Per-tenant + global ledger of (timestamp, usd) entries. Same caveat as
  // the rate-limit store — no pruning in v1.
  private tenantLedger = new Map<string, Array<{ at: Date; usd: number }>>();
  private globalLedger: Array<{ at: Date; usd: number }> = [];

  async getTenantSpend(tenantId: string, since: Date): Promise<number> {
    const list = this.tenantLedger.get(tenantId) ?? [];
    return list
      .filter((e) => e.at.getTime() >= since.getTime())
      .reduce((acc, e) => acc + e.usd, 0);
  }

  async getGlobalSpend(since: Date): Promise<number> {
    return this.globalLedger
      .filter((e) => e.at.getTime() >= since.getTime())
      .reduce((acc, e) => acc + e.usd, 0);
  }

  async recordSpend(tenantId: string, usd: number, at: Date): Promise<void> {
    const list = this.tenantLedger.get(tenantId) ?? [];
    list.push({ at, usd });
    this.tenantLedger.set(tenantId, list);
    this.globalLedger.push({ at, usd });
  }
}

export interface CapturedAlert {
  level: AlertLevel;
  payload: AlertPayload;
  at: Date;
}

export class CapturingAlerter implements Alerter {
  readonly fired: CapturedAlert[] = [];
  fire(level: AlertLevel, payload: AlertPayload): void {
    this.fired.push({ level, payload, at: new Date() });
  }
}

// Default prod-ish alerter: writes a single structured stderr line per alert.
// Real prod swaps this for a PagerDuty/Slack webhook. Stderr is enough for
// the v1 design partner deploy because we'll be tailing logs anyway.
export class StderrAlerter implements Alerter {
  fire(level: AlertLevel, payload: AlertPayload): void {
    const line = JSON.stringify({ kind: 'cost-alert', level, ...payload });
    process.stderr.write(line + '\n');
  }
}
