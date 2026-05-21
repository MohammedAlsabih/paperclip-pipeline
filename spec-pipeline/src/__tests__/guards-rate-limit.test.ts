import {
  RateLimiter,
  DEFAULT_RATE_LIMIT_CONFIG,
  FixedClock,
  InMemoryRateLimitStore,
} from '../guards';

function makeLimiter(initialAt = new Date('2026-05-03T00:00:00Z')) {
  const clock = new FixedClock(initialAt);
  const store = new InMemoryRateLimitStore();
  const limiter = new RateLimiter(DEFAULT_RATE_LIMIT_CONFIG, store, clock);
  return { clock, store, limiter };
}

describe('RateLimiter (T12 — per-user pipeline-start rate limit)', () => {
  test('allows the first 10 starts in an hour, rejects the 11th with 429 + retry-after', async () => {
    const { limiter } = makeLimiter();

    for (let i = 0; i < 10; i++) {
      const ok = await limiter.tryStart('alice', 'user');
      expect(ok.ok).toBe(true);
    }

    const eleventh = await limiter.tryStart('alice', 'user');
    expect(eleventh.ok).toBe(false);
    if (!eleventh.ok) {
      expect(eleventh.reason).toBe('hour-exceeded');
      expect(eleventh.retryAfterSec).toBeGreaterThan(0);
      expect(eleventh.currentCount).toBe(10);
      expect(eleventh.limit).toBe(10);
    }
  });

  test('admin role bypasses the limit entirely', async () => {
    const { limiter } = makeLimiter();

    // Burn through the user limit first.
    for (let i = 0; i < 10; i++) {
      await limiter.tryStart('bob', 'user');
    }
    // Same user, but called as admin: must succeed even after the user
    // budget is fully consumed.
    const adminCall = await limiter.tryStart('bob', 'admin');
    expect(adminCall.ok).toBe(true);

    // And another admin call still works — admin is unbounded by hour.
    const adminCall2 = await limiter.tryStart('bob', 'admin');
    expect(adminCall2.ok).toBe(true);
  });

  test('limits are per-user — alice exhausting does not affect bob', async () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 10; i++) {
      await limiter.tryStart('alice', 'user');
    }
    const aliceBlocked = await limiter.tryStart('alice', 'user');
    expect(aliceBlocked.ok).toBe(false);

    const bobOk = await limiter.tryStart('bob', 'user');
    expect(bobOk.ok).toBe(true);
  });

  test('window slides — after 1 hour the user can submit again', async () => {
    const { clock, limiter } = makeLimiter();
    for (let i = 0; i < 10; i++) {
      await limiter.tryStart('carol', 'user');
    }
    // At T+0 the user is blocked.
    const blocked = await limiter.tryStart('carol', 'user');
    expect(blocked.ok).toBe(false);

    // Advance the clock past the hourly window.
    clock.advance(60 * 60 * 1000 + 1);
    const ok = await limiter.tryStart('carol', 'user');
    expect(ok.ok).toBe(true);
  });

  test('daily cap kicks in after 50 starts even within multiple sliding hours', async () => {
    const { clock, limiter } = makeLimiter();
    // 5 hours * 10 starts each = 50 starts total within 5 hours, all under
    // the 24h day window. The 51st start in the day is rejected.
    for (let h = 0; h < 5; h++) {
      for (let i = 0; i < 10; i++) {
        await limiter.tryStart('dave', 'user');
      }
      // Advance 1h+1s so we leave the hourly window for the next batch.
      clock.advance(60 * 60 * 1000 + 1000);
    }
    const blocked = await limiter.tryStart('dave', 'user');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.reason).toBe('day-exceeded');
      expect(blocked.retryAfterSec).toBeGreaterThan(0);
    }
  });
});
