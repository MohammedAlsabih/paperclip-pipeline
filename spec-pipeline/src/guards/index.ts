export {
  validateSpecSize,
  DEFAULT_SPEC_SIZE_LIMITS,
} from './spec-size';
export type { SpecSizeLimits, SpecSizeResult } from './spec-size';

export { RateLimiter, DEFAULT_RATE_LIMIT_CONFIG } from './rate-limit';
export type { RateLimitConfig, RateLimitDecision } from './rate-limit';

export {
  CostBudgetGuard,
  DEFAULT_COST_CEILING_CONFIG,
} from './cost-budget';
export type {
  CostCeilingConfig,
  CostBudgetDecision,
  CostBreakerScope,
} from './cost-budget';

export {
  estimateTokens,
  checkPromptBudget,
  checkOutputBudget,
  maxTokensForStage,
  DEFAULT_AGENT_BUDGETS,
} from './agent-budget';
export type { AgentStage, StageBudget, AgentBudgetResult } from './agent-budget';

export { checkPipelineStart, toHttpRejection } from './pipeline-gate';
export type {
  PipelineStartContext,
  PipelineStartGuards,
  PipelineStartDecision,
  HttpRejection,
} from './pipeline-gate';

export {
  SystemClock,
  FixedClock,
  InMemoryRateLimitStore,
  InMemorySpendStore,
  CapturingAlerter,
  StderrAlerter,
} from './in-memory';
export type { CapturedAlert } from './in-memory';

export type {
  Clock,
  RateLimitStore,
  SpendStore,
  Alerter,
  AlertLevel,
  AlertPayload,
  UserRole,
} from './types';
