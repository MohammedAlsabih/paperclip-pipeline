// The pipeline-start gate composes the four guards into a single check that
// runPipeline calls before doing any LLM-spending work. Each guard remains
// usable on its own (e.g., spec-size is also called at HTTP ingress before
// we even allocate a pipeline run id), but at the pipeline-start boundary
// we fail-closed on the first guard that rejects.

import type { CostBudgetGuard, CostBudgetDecision } from './cost-budget';
import type { RateLimiter, RateLimitDecision } from './rate-limit';
import type { SpecSizeLimits, SpecSizeResult } from './spec-size';
import { validateSpecSize, DEFAULT_SPEC_SIZE_LIMITS } from './spec-size';
import type { UserRole } from './types';

export interface PipelineStartContext {
  // The user-supplied raw spec text (pre-parse).
  rawSpec: string;
  // The canonicalized spec object, post-parse. Pass undefined if we are
  // gating before the parse step (in that case only raw size is checked).
  normalizedSpec?: unknown;
  userId: string;
  userRole: UserRole;
  tenantId: string;
}

export interface PipelineStartGuards {
  rateLimiter: RateLimiter;
  costGuard: CostBudgetGuard;
  specSizeLimits?: SpecSizeLimits;
}

export type PipelineStartDecision =
  | { ok: true; warnings: { source: 'cost-budget'; payload: unknown }[] }
  | { ok: false; source: 'spec-size'; result: SpecSizeResult }
  | { ok: false; source: 'rate-limit'; result: RateLimitDecision }
  | { ok: false; source: 'cost-budget'; result: CostBudgetDecision };

// Run all four guards in the documented order. Order is:
//   1. spec-size (cheap, no I/O, rejects garbage before we touch the store)
//   2. rate-limit (per-user; one store hit)
//   3. cost-budget (per-tenant + global; four store hits in parallel)
// Each guard short-circuits on rejection.
export async function checkPipelineStart(
  ctx: PipelineStartContext,
  guards: PipelineStartGuards,
): Promise<PipelineStartDecision> {
  const limits = guards.specSizeLimits ?? DEFAULT_SPEC_SIZE_LIMITS;

  const sizeResult =
    ctx.normalizedSpec !== undefined
      ? validateSpecSize(ctx.rawSpec, ctx.normalizedSpec, limits)
      : validateSpecSize(ctx.rawSpec, {}, limits);
  if (!sizeResult.ok) {
    return { ok: false, source: 'spec-size', result: sizeResult };
  }

  const rateResult = await guards.rateLimiter.tryStart(ctx.userId, ctx.userRole);
  if (!rateResult.ok) {
    return { ok: false, source: 'rate-limit', result: rateResult };
  }

  const costResult = await guards.costGuard.checkBefore(ctx.tenantId);
  if (!costResult.ok) {
    return { ok: false, source: 'cost-budget', result: costResult };
  }

  return {
    ok: true,
    warnings: costResult.warnings.map((w) => ({ source: 'cost-budget' as const, payload: w })),
  };
}

// Translate a guard rejection into the HTTP-shaped fields the ingress will
// need (status + retry-after + reason code). The ingress layer is not in
// this repo yet (MAL-48 builds the gate; HTTP plumbing follows in MAL-49+),
// but exposing this mapping here means the ingress only has to pass the
// shape through to its framework.
export interface HttpRejection {
  status: 400 | 413 | 429 | 503;
  retryAfterSec?: number;
  code: string;
  message: string;
}

export function toHttpRejection(decision: PipelineStartDecision): HttpRejection | null {
  if (decision.ok) return null;
  switch (decision.source) {
    case 'spec-size':
      return {
        status: 413,
        code: `spec-size:${decision.result.ok ? 'ok' : decision.result.reason}`,
        message: decision.result.ok
          ? 'spec size ok'
          : `spec size ${decision.result.reason}: ${decision.result.bytes} > ${decision.result.limit}`,
      };
    case 'rate-limit':
      if (decision.result.ok) return null;
      return {
        status: 429,
        retryAfterSec: decision.result.retryAfterSec,
        code: `rate-limit:${decision.result.reason}`,
        message: `pipeline starts ${decision.result.reason} (${decision.result.currentCount}/${decision.result.limit})`,
      };
    case 'cost-budget':
      if (decision.result.ok) return null;
      return {
        status: 503,
        retryAfterSec: 600,
        code: `cost-budget:${decision.result.reason}`,
        message: decision.result.alert.message,
      };
  }
}
