import {
  CapturingAlerter,
  CostBudgetGuard,
  DEFAULT_COST_CEILING_CONFIG,
  FixedClock,
  InMemorySpendStore,
} from '../guards';

function makeGuard(
  cfgOverrides: Partial<typeof DEFAULT_COST_CEILING_CONFIG> = {},
  initialAt = new Date('2026-05-03T00:00:00Z'),
) {
  const cfg = { ...DEFAULT_COST_CEILING_CONFIG, ...cfgOverrides };
  const clock = new FixedClock(initialAt);
  const store = new InMemorySpendStore();
  const alerter = new CapturingAlerter();
  const guard = new CostBudgetGuard(cfg, store, alerter, clock);
  return { cfg, clock, store, alerter, guard };
}

describe('CostBudgetGuard (T12/O2 — Anthropic cost ceiling circuit breaker)', () => {
  test('allows new starts when spend is well below ceiling', async () => {
    const { guard, alerter } = makeGuard({
      tenantDailyUsd: 100,
      tenantMonthlyUsd: 1000,
    });
    await guard.recordSpend('acme', 5);
    const dec = await guard.checkBefore('acme');
    expect(dec.ok).toBe(true);
    if (dec.ok) expect(dec.warnings).toHaveLength(0);
    expect(alerter.fired).toHaveLength(0);
  });

  test('per-tenant daily ceiling: simulated spend > ceiling pauses new starts and fires critical alert', async () => {
    const { guard, alerter } = makeGuard({
      tenantDailyUsd: 50,
      tenantMonthlyUsd: 9999,
      globalDailyUsd: 9999,
      globalMonthlyUsd: 999999,
    });
    await guard.recordSpend('acme', 60);

    const dec = await guard.checkBefore('acme');
    expect(dec.ok).toBe(false);
    if (!dec.ok) {
      expect(dec.reason).toBe('tenant-daily');
      expect(dec.current).toBe(60);
      expect(dec.limit).toBe(50);
    }

    // Critical alert fired exactly once; repeated checkBefore does not spam.
    expect(alerter.fired).toHaveLength(1);
    expect(alerter.fired[0].level).toBe('critical');
    expect(alerter.fired[0].payload.code).toBe('cost-tenant-daily-tripped');
    expect(alerter.fired[0].payload.tenantId).toBe('acme');

    await guard.checkBefore('acme');
    await guard.checkBefore('acme');
    expect(alerter.fired).toHaveLength(1); // dedup
  });

  test('warn alert fires once at 80% of ceiling, before the breaker trips', async () => {
    const { guard, alerter } = makeGuard({
      tenantDailyUsd: 100,
      tenantMonthlyUsd: 9999,
      globalDailyUsd: 9999,
      globalMonthlyUsd: 999999,
      alertWarnRatio: 0.8,
    });

    await guard.recordSpend('acme', 85); // 85% — past warn threshold, under cap
    const dec = await guard.checkBefore('acme');
    expect(dec.ok).toBe(true);
    if (dec.ok) {
      expect(dec.warnings).toHaveLength(1);
      expect(dec.warnings[0]).toMatchObject({
        code: 'cost-tenant-daily-warn',
      });
    }

    expect(alerter.fired).toHaveLength(1);
    expect(alerter.fired[0].level).toBe('warn');
    expect(alerter.fired[0].payload.code).toBe('cost-tenant-daily-warn');

    // Repeated check at the same level does not fire again.
    await guard.checkBefore('acme');
    expect(alerter.fired).toHaveLength(1);
  });

  test('global circuit breaker fires before monthly Anthropic budget is exceeded', async () => {
    const { guard, alerter } = makeGuard({
      // High per-tenant caps so global is the binding constraint.
      tenantDailyUsd: 9999,
      tenantMonthlyUsd: 999999,
      globalDailyUsd: 9999,
      globalMonthlyUsd: 1000,
    });
    // Spread across two tenants — neither alone hits its cap.
    await guard.recordSpend('acme', 600);
    await guard.recordSpend('beta', 500);

    const dec = await guard.checkBefore('gamma');
    expect(dec.ok).toBe(false);
    if (!dec.ok) {
      expect(dec.reason).toBe('global-monthly');
      expect(dec.current).toBeGreaterThanOrEqual(1000);
    }

    // Critical alert fired with no tenantId (global scope).
    const critical = alerter.fired.find((a) => a.level === 'critical');
    expect(critical).toBeDefined();
    expect(critical!.payload.code).toBe('cost-global-monthly-tripped');
    expect(critical!.payload.tenantId).toBeUndefined();
  });

  test('isolation: tenant A hitting its cap does not affect tenant B', async () => {
    const { guard } = makeGuard({
      tenantDailyUsd: 50,
      tenantMonthlyUsd: 9999,
      globalDailyUsd: 9999,
      globalMonthlyUsd: 999999,
    });
    await guard.recordSpend('acme', 100); // acme is over

    const acme = await guard.checkBefore('acme');
    expect(acme.ok).toBe(false);

    const beta = await guard.checkBefore('beta');
    expect(beta.ok).toBe(true);
  });

  test('recordSpend rejects negative or non-finite usd values', async () => {
    const { guard } = makeGuard();
    await expect(guard.recordSpend('acme', -1)).rejects.toThrow();
    await expect(guard.recordSpend('acme', NaN)).rejects.toThrow();
    await expect(guard.recordSpend('acme', Infinity)).rejects.toThrow();
  });
});
