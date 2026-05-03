import {
  CapturingAlerter,
  CostBudgetGuard,
  DEFAULT_COST_CEILING_CONFIG,
  DEFAULT_RATE_LIMIT_CONFIG,
  DEFAULT_SPEC_SIZE_LIMITS,
  FixedClock,
  InMemoryRateLimitStore,
  InMemorySpendStore,
  RateLimiter,
  checkPipelineStart,
  toHttpRejection,
} from '../guards';

function makeGuards() {
  const clock = new FixedClock(new Date('2026-05-03T00:00:00Z'));
  const rateLimiter = new RateLimiter(
    DEFAULT_RATE_LIMIT_CONFIG,
    new InMemoryRateLimitStore(),
    clock,
  );
  const costGuard = new CostBudgetGuard(
    {
      ...DEFAULT_COST_CEILING_CONFIG,
      tenantDailyUsd: 100,
      tenantMonthlyUsd: 1000,
      globalDailyUsd: 1000,
      globalMonthlyUsd: 10000,
    },
    new InMemorySpendStore(),
    new CapturingAlerter(),
    clock,
  );
  return { clock, rateLimiter, costGuard };
}

describe('checkPipelineStart (T11/T12/O2 — composed pipeline-start gate)', () => {
  test('happy path: small spec, fresh user, no spend → ok with no warnings', async () => {
    const guards = makeGuards();
    const decision = await checkPipelineStart(
      {
        rawSpec: '# Add login',
        normalizedSpec: { feature_description: 'add login' },
        userId: 'alice',
        userRole: 'user',
        tenantId: 'acme',
      },
      guards,
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.warnings).toHaveLength(0);
  });

  test('spec-size short-circuit: oversized raw rejects before rate-limit is consulted', async () => {
    const guards = makeGuards();
    const huge = 'x'.repeat(DEFAULT_SPEC_SIZE_LIMITS.maxRawBytes + 1);
    const decision = await checkPipelineStart(
      {
        rawSpec: huge,
        normalizedSpec: {},
        userId: 'alice',
        userRole: 'user',
        tenantId: 'acme',
      },
      guards,
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.source).toBe('spec-size');

    // The rate-limit store must not have been touched — alice should still
    // have her full hourly budget available on the next call.
    const next = await checkPipelineStart(
      {
        rawSpec: '# ok',
        normalizedSpec: { x: 'y' },
        userId: 'alice',
        userRole: 'user',
        tenantId: 'acme',
      },
      guards,
    );
    expect(next.ok).toBe(true);
  });

  test('rate-limit rejection maps to HTTP 429 with retry-after', async () => {
    const guards = makeGuards();
    // Burn the user limit.
    for (let i = 0; i < 10; i++) {
      await checkPipelineStart(
        {
          rawSpec: '# ok',
          normalizedSpec: { x: 'y' },
          userId: 'eve',
          userRole: 'user',
          tenantId: 'acme',
        },
        guards,
      );
    }

    const eleventh = await checkPipelineStart(
      {
        rawSpec: '# ok',
        normalizedSpec: { x: 'y' },
        userId: 'eve',
        userRole: 'user',
        tenantId: 'acme',
      },
      guards,
    );
    expect(eleventh.ok).toBe(false);

    const http = toHttpRejection(eleventh);
    expect(http).not.toBeNull();
    expect(http!.status).toBe(429);
    expect(http!.retryAfterSec).toBeGreaterThan(0);
    expect(http!.code).toMatch(/^rate-limit:/);
  });

  test('admin role bypasses rate-limit even when user budget is exhausted', async () => {
    const guards = makeGuards();
    for (let i = 0; i < 10; i++) {
      await checkPipelineStart(
        {
          rawSpec: '# ok',
          normalizedSpec: { x: 'y' },
          userId: 'op',
          userRole: 'user',
          tenantId: 'acme',
        },
        guards,
      );
    }
    const adminCall = await checkPipelineStart(
      {
        rawSpec: '# ok',
        normalizedSpec: { x: 'y' },
        userId: 'op',
        userRole: 'admin',
        tenantId: 'acme',
      },
      guards,
    );
    expect(adminCall.ok).toBe(true);
  });

  test('cost-budget rejection maps to HTTP 503 with retry-after', async () => {
    const guards = makeGuards();
    // Push tenant over its daily cap.
    await guards.costGuard.recordSpend('acme', 200);

    const decision = await checkPipelineStart(
      {
        rawSpec: '# ok',
        normalizedSpec: { x: 'y' },
        userId: 'frank',
        userRole: 'user',
        tenantId: 'acme',
      },
      guards,
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.source).toBe('cost-budget');

    const http = toHttpRejection(decision);
    expect(http!.status).toBe(503);
    expect(http!.retryAfterSec).toBeGreaterThan(0);
    expect(http!.code).toMatch(/^cost-budget:/);
  });
});
