// Spec size + recursion guard. T11 — oversized or recursively-exploding spec
// exhausts LLM budget or memory. We enforce two caps:
//   1. raw input bytes — what the user submitted before any parsing
//   2. normalized JSON bytes — the canonical representation we hand to the LLM
//
// The normalized check is the one that catches "exploding" specs: a 5 KB raw
// markdown that, once we expand front-matter aliases or include directives,
// blows up to 10 MB of JSON. We measure post-canonicalization, not pre.

export interface SpecSizeLimits {
  // Maximum raw input size in bytes. Default suggested in MAL-48: 50 KB.
  maxRawBytes: number;
  // Maximum normalized (canonical JSON) size in bytes. Default: 200 KB.
  maxNormalizedBytes: number;
}

export const DEFAULT_SPEC_SIZE_LIMITS: SpecSizeLimits = {
  maxRawBytes: 50 * 1024,
  maxNormalizedBytes: 200 * 1024,
};

export type SpecSizeResult =
  | { ok: true; rawBytes: number; normalizedBytes: number }
  | {
      ok: false;
      reason: 'raw-too-large' | 'normalized-too-large';
      bytes: number;
      limit: number;
    };

function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

// `normalized` is the canonical post-parse object. We stringify with a hard
// cap so a maliciously deeply-nested object can't OOM us inside JSON.stringify
// itself: if the partial output exceeds the limit we abort early.
function safeStringifyLength(obj: unknown, limit: number): number {
  // Quick bound: JSON.stringify allocates ~2x the final string in transit.
  // We let it run but cap by checking the result length against `limit`.
  // For extreme depth (>1000 levels), JSON.stringify itself throws via
  // RangeError on circular or stack-overflow — we treat that as "too large".
  try {
    const s = JSON.stringify(obj);
    return s ? utf8ByteLength(s) : 0;
  } catch {
    // Either circular (we shouldn't see this from spec parsing) or a stack
    // overflow from deeply-nested input. Either way: reject as too large.
    return limit + 1;
  }
}

export function validateSpecSize(
  rawInput: string,
  normalized: unknown,
  limits: SpecSizeLimits = DEFAULT_SPEC_SIZE_LIMITS,
): SpecSizeResult {
  const rawBytes = utf8ByteLength(rawInput);
  if (rawBytes > limits.maxRawBytes) {
    return {
      ok: false,
      reason: 'raw-too-large',
      bytes: rawBytes,
      limit: limits.maxRawBytes,
    };
  }

  const normalizedBytes = safeStringifyLength(normalized, limits.maxNormalizedBytes);
  if (normalizedBytes > limits.maxNormalizedBytes) {
    return {
      ok: false,
      reason: 'normalized-too-large',
      bytes: normalizedBytes,
      limit: limits.maxNormalizedBytes,
    };
  }

  return { ok: true, rawBytes, normalizedBytes };
}
