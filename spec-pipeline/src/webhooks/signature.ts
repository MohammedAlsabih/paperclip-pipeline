import * as crypto from 'crypto';

const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_PREFIX = 'sha256=';

export interface SignatureVerification {
  ok: boolean;
  reason?: 'missing-header' | 'malformed-header' | 'mismatch' | 'empty-secret';
}

// Constant-time HMAC-SHA256 verification of a GitHub webhook delivery.
// Caller MUST pass the *raw* request body buffer — re-encoding the JSON
// invalidates the signature.
export function verifyGithubSignature(
  rawBody: Buffer,
  secret: string,
  signatureHeader: string | undefined,
): SignatureVerification {
  if (!secret) return { ok: false, reason: 'empty-secret' };
  if (!signatureHeader) return { ok: false, reason: 'missing-header' };
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, reason: 'malformed-header' };
  }

  const provided = signatureHeader.slice(SIGNATURE_PREFIX.length);
  // hex chars only; reject anything else without touching HMAC compute
  if (!/^[0-9a-f]+$/i.test(provided) || provided.length !== 64) {
    return { ok: false, reason: 'malformed-header' };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length) return { ok: false, reason: 'mismatch' };
  const equal = crypto.timingSafeEqual(a, b);
  return equal ? { ok: true } : { ok: false, reason: 'mismatch' };
}

export function pickSignatureHeader(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers[SIGNATURE_HEADER] ?? headers[SIGNATURE_HEADER.toUpperCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}
