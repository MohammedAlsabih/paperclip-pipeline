import { validateSpecSize, DEFAULT_SPEC_SIZE_LIMITS } from '../guards';

describe('validateSpecSize (T11 — oversized / recursive spec rejection)', () => {
  test('accepts a normal-sized spec', () => {
    const raw = '# Add CRUD\n\nAdd an authenticated CRUD route.\n';
    const normalized = { feature_description: 'Add an authenticated CRUD route.' };
    const result = validateSpecSize(raw, normalized);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rawBytes).toBe(Buffer.byteLength(raw, 'utf-8'));
      expect(result.normalizedBytes).toBeGreaterThan(0);
    }
  });

  test('rejects raw input over the cap with reason=raw-too-large', () => {
    const raw = 'x'.repeat(DEFAULT_SPEC_SIZE_LIMITS.maxRawBytes + 1);
    const result = validateSpecSize(raw, { feature_description: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('raw-too-large');
      expect(result.bytes).toBe(DEFAULT_SPEC_SIZE_LIMITS.maxRawBytes + 1);
      expect(result.limit).toBe(DEFAULT_SPEC_SIZE_LIMITS.maxRawBytes);
    }
  });

  test('rejects normalized JSON over the cap with reason=normalized-too-large (recursive/exploding spec)', () => {
    // A small raw input (well under raw cap) that expands to a huge
    // normalized object — the "recursive expansion" T11 case.
    const raw = '# Tiny spec';
    const huge = { acceptance_criteria: Array(100_000).fill('do the thing') };
    const result = validateSpecSize(raw, huge);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('normalized-too-large');
      expect(result.bytes).toBeGreaterThan(DEFAULT_SPEC_SIZE_LIMITS.maxNormalizedBytes);
    }
  });

  test('handles deeply-nested normalized objects without OOM', () => {
    // Build a depth-5000 object. JSON.stringify either succeeds (small
    // payload, accepted) or throws (rejected as too-large by safeStringify).
    let nested: Record<string, unknown> = {};
    let cur = nested;
    for (let i = 0; i < 5000; i++) {
      cur.next = {};
      cur = cur.next as Record<string, unknown>;
    }
    const result = validateSpecSize('# nested', nested);
    // Either path is acceptable; the test asserts we don't throw.
    expect(typeof result.ok).toBe('boolean');
  });

  test('honors caller-supplied limits', () => {
    const result = validateSpecSize(
      'hello',
      { x: 'y' },
      { maxRawBytes: 1, maxNormalizedBytes: 1_000 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('raw-too-large');
  });
});
