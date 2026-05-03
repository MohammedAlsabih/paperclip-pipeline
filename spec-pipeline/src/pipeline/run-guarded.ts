// MAL-48: guarded entry point. Sits in front of `runPipeline` to enforce
// the v1 DoS + cost-burn gates (T11/T12/O2) before any LLM-spending step
// runs. Kept as a sibling rather than baking the gate into runPipeline so:
//   - the local CLI demo continues to work unchanged (no guard config)
//   - the future HTTP ingress and any multi-tenant deployment have a single
//     opt-in call site that is hard to bypass: `runGuardedPipeline` instead
//     of the unguarded `runPipeline`.
//
// Defense in depth: the same gates are intended to fire at HTTP ingress
// (when `checkPipelineStart` is called with `normalizedSpec` undefined, so
// only raw size + rate limit + cost are checked pre-parse) AND here, after
// parse, where the normalized-bytes branch of the spec-size guard catches
// recursive expansion that ingress couldn't see.

import * as fs from 'fs';
import { parseSpec } from '../spec-parser';
import {
  checkPipelineStart,
  toHttpRejection,
} from '../guards';
import type {
  HttpRejection,
  PipelineStartGuards,
  UserRole,
} from '../guards';
import { runPipeline } from './run';
import type { PipelineOptions, PipelineResult } from './run';

export interface GuardedPipelineOptions extends PipelineOptions {
  guards: PipelineStartGuards;
  userId: string;
  userRole?: UserRole;
  tenantId: string;
}

export class PipelineGuardRejection extends Error {
  constructor(public readonly rejection: HttpRejection) {
    super(rejection.message);
    this.name = 'PipelineGuardRejection';
  }
}

// Reads the spec, validates it through the four guards, and only then hands
// off to the unguarded `runPipeline`. Throws PipelineGuardRejection on any
// gate rejection — the caller (HTTP ingress) maps this to its framework
// response (status, retry-after, body) via `rejection.rejection`.
export async function runGuardedPipeline(
  options: GuardedPipelineOptions,
): Promise<PipelineResult> {
  const rawSpec = fs.readFileSync(options.specPath, 'utf-8');
  const spec = parseSpec(rawSpec);

  const decision = await checkPipelineStart(
    {
      rawSpec,
      normalizedSpec: spec,
      userId: options.userId,
      userRole: options.userRole ?? 'user',
      tenantId: options.tenantId,
    },
    options.guards,
  );

  if (!decision.ok) {
    const rejection = toHttpRejection(decision)!;
    throw new PipelineGuardRejection(rejection);
  }

  return runPipeline(options);
}
