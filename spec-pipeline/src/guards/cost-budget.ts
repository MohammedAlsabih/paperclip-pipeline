// Anthropic cost-burn circuit breaker. T12 / O2 — once daily or monthly
// spend crosses a configured ceiling, new pipeline starts are paused and an
// alert fires to CTO + CISO. Two scopes enforced together:
//   - per-tenant (so one design partner's runaway can't burn the others)
//   - global   (so even a perfect-scoring single tenant can't burn the
//                whole monthly Anthropic budget)
//
// The breaker reads counters from a `SpendStore` (so prod can use Postgres
// or Redis, tests use in-memory). It fires at most one alert per (tenant,
// scope, level) per process lifetime by tracking what it has already
// notified — repeated `checkBefore` calls when the breaker is tripped do
// NOT spam the alert channel. The store's view of counts is authoritative;
// the in-memory dedup is best-effort.

import type {
  AlertLevel,
  AlertPayload,
  Alerter,
  Clock,
  SpendStore,
} from './types';

export interface CostCeilingConfig {
  // Per-tenant caps. Default suggested for v1 is intentionally conservative
  // because we are pre-revenue and a single design partner ≈ one tenant.
  tenantDailyUsd: number;
  tenantMonthlyUsd: number;
  // Global caps. When global is hit, ALL tenants are paused until reset.
  globalDailyUsd: number;
  globalMonthlyUsd: number;
  // Soft warning threshold as a fraction of the cap (e.g., 0.8 = warn at
  // 80% spent). Fires a 'warn' alert exactly once per scope+window+process.
  alertWarnRatio: number;
}

export const DEFAULT_COST_CEILING_CONFIG: CostCeilingConfig = {
  // v1 placeholder — operator MUST override per design partner.
  tenantDailyUsd: 50,
  tenantMonthlyUsd: 500,
  globalDailyUsd: 200,
  globalMonthlyUsd: 3000,
  alertWarnRatio: 0.8,
};

export type CostBreakerScope =
  | 'tenant-daily'
  | 'tenant-monthly'
  | 'global-daily'
  | 'global-monthly';

export type CostBudgetDecision =
  | { ok: true; warnings: AlertPayload[] }
  | {
      ok: false;
      reason: CostBreakerScope;
      current: number;
      limit: number;
      alert: AlertPayload;
    };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;

export class CostBudgetGuard {
  // Process-local dedupe so the same scope+level pair only alerts once even
  // if checkBefore is called repeatedly. Format: `${scope}:${level}:${tenantId|''}`.
  private alertedKeys = new Set<string>();

  constructor(
    private readonly cfg: CostCeilingConfig,
    private readonly store: SpendStore,
    private readonly alerter: Alerter,
    private readonly clock: Clock,
  ) {}

  // Call BEFORE starting an LLM-spending operation for `tenantId`. Returns
  // ok=false if any of the four ceilings would be tripped right now.
  async checkBefore(tenantId: string): Promise<CostBudgetDecision> {
    const now = this.clock.now();
    const dayStart = new Date(now.getTime() - DAY_MS);
    const monthStart = new Date(now.getTime() - MONTH_MS);

    const [tenantDay, tenantMonth, globalDay, globalMonth] = await Promise.all([
      this.store.getTenantSpend(tenantId, dayStart),
      this.store.getTenantSpend(tenantId, monthStart),
      this.store.getGlobalSpend(dayStart),
      this.store.getGlobalSpend(monthStart),
    ]);

    // Order matters: check the tightest scope first so the rejection reason
    // is the most actionable. Tenant-daily before tenant-monthly before
    // global-daily before global-monthly.
    const checks: Array<{
      scope: CostBreakerScope;
      current: number;
      limit: number;
    }> = [
      { scope: 'tenant-daily', current: tenantDay, limit: this.cfg.tenantDailyUsd },
      { scope: 'tenant-monthly', current: tenantMonth, limit: this.cfg.tenantMonthlyUsd },
      { scope: 'global-daily', current: globalDay, limit: this.cfg.globalDailyUsd },
      { scope: 'global-monthly', current: globalMonth, limit: this.cfg.globalMonthlyUsd },
    ];

    const warnings: AlertPayload[] = [];
    for (const c of checks) {
      if (c.current >= c.limit) {
        const alert: AlertPayload = {
          code: `cost-${c.scope}-tripped`,
          message: `Anthropic spend ${c.scope} ceiling tripped: $${c.current.toFixed(2)} >= $${c.limit.toFixed(2)}`,
          tenantId: c.scope.startsWith('tenant-') ? tenantId : undefined,
          current: c.current,
          limit: c.limit,
        };
        this.fireOnce('critical', c.scope, tenantId, alert);
        return {
          ok: false,
          reason: c.scope,
          current: c.current,
          limit: c.limit,
          alert,
        };
      }
      if (c.current >= c.limit * this.cfg.alertWarnRatio) {
        const warn: AlertPayload = {
          code: `cost-${c.scope}-warn`,
          message: `Anthropic spend ${c.scope} at ${((c.current / c.limit) * 100).toFixed(0)}% of cap`,
          tenantId: c.scope.startsWith('tenant-') ? tenantId : undefined,
          current: c.current,
          limit: c.limit,
        };
        if (this.fireOnce('warn', c.scope, tenantId, warn)) {
          warnings.push(warn);
        }
      }
    }

    return { ok: true, warnings };
  }

  // Call AFTER an LLM call completes with the actual USD spend. If this push
  // takes us over a ceiling, the next checkBefore will reject.
  async recordSpend(tenantId: string, usd: number): Promise<void> {
    if (!Number.isFinite(usd) || usd < 0) {
      throw new Error(`recordSpend: usd must be a non-negative finite number, got ${usd}`);
    }
    await this.store.recordSpend(tenantId, usd, this.clock.now());
  }

  // Returns true if the alert was actually fired (first time for this key),
  // false if it was deduped. Critical alerts dedup separately from warns so
  // an at-cap critical can still fire even if we already warned at 80%.
  private fireOnce(
    level: AlertLevel,
    scope: CostBreakerScope,
    tenantId: string,
    payload: AlertPayload,
  ): boolean {
    const tenantKey = scope.startsWith('tenant-') ? tenantId : '';
    const key = `${scope}:${level}:${tenantKey}`;
    if (this.alertedKeys.has(key)) return false;
    this.alertedKeys.add(key);
    this.alerter.fire(level, payload);
    return true;
  }
}
