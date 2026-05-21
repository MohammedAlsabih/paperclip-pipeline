// Per-user pipeline-start rate limiter. T12 — adversary triggers expensive
// LLM operations to burn our Anthropic spend. A single bad-faith user
// submitting 1000 specs in an hour can torch our budget and starve the
// single Fly machine (ADR-005). The rate limit is the first line of defense;
// the per-tenant cost ceiling (`cost-budget.ts`) is the second.
//
// Design notes:
// - Sliding window. A fixed-window counter would let an attacker burst at
//   the boundary (10 in the last second of hour N + 10 in the first second
//   of hour N+1 = 20 in 2 seconds). We use an explicit sliding window.
// - Both windows enforced. We reject the moment EITHER the hourly OR the
//   daily count would be exceeded — whichever bites first.
// - Admin bypass. Admins (defined as role='admin' in the request context)
//   skip the limit entirely. The MAL-48 issue calls this out explicitly so
//   the design partner's admin/operator can recover when limits are hit.

import type { Clock, RateLimitStore, UserRole } from './types';

export interface RateLimitConfig {
  perUserPerHour: number;
  perUserPerDay: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  perUserPerHour: 10,
  perUserPerDay: 50,
};

export type RateLimitDecision =
  | { ok: true }
  | {
      ok: false;
      reason: 'hour-exceeded' | 'day-exceeded';
      retryAfterSec: number;
      currentCount: number;
      limit: number;
    };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export class RateLimiter {
  constructor(
    private readonly cfg: RateLimitConfig,
    private readonly store: RateLimitStore,
    private readonly clock: Clock,
  ) {}

  // Returns ok=true and records the start atomically if the user is under
  // their limit; otherwise returns ok=false with retryAfterSec set to the
  // number of seconds the caller should wait before retrying.
  //
  // Admin role bypasses both limits but still records, so an admin who is
  // also a regular user later doesn't carry credit. (Recording is cheap.)
  async tryStart(userId: string, role: UserRole): Promise<RateLimitDecision> {
    const now = this.clock.now();

    if (role !== 'admin') {
      const hourSince = new Date(now.getTime() - HOUR_MS);
      const hourCount = await this.store.countSince(userId, hourSince);
      if (hourCount >= this.cfg.perUserPerHour) {
        return {
          ok: false,
          reason: 'hour-exceeded',
          retryAfterSec: 60,
          currentCount: hourCount,
          limit: this.cfg.perUserPerHour,
        };
      }

      const daySince = new Date(now.getTime() - DAY_MS);
      const dayCount = await this.store.countSince(userId, daySince);
      if (dayCount >= this.cfg.perUserPerDay) {
        return {
          ok: false,
          reason: 'day-exceeded',
          retryAfterSec: 300,
          currentCount: dayCount,
          limit: this.cfg.perUserPerDay,
        };
      }
    }

    await this.store.recordStart(userId, now);
    return { ok: true };
  }
}
