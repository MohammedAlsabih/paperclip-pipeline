// Per-agent prompt + output token budget. T11 — oversized prompts inflate
// LLM cost AND can drive the model into context-window overflow which fails
// open in surprising ways. We bound prompt + output for each pipeline stage.
//
// Token estimate: we deliberately use a cheap character-based heuristic
// (chars / 4) instead of pulling in a real tokenizer. The heuristic
// over-estimates for code-heavy prompts (which is fine — fail closed) and
// under-estimates for whitespace-heavy prompts by at most ~15% (which is
// still well inside the cap headroom).

export type AgentStage = 'pm' | 'architect' | 'engineer' | 'review';

export interface StageBudget {
  // Maximum estimated input prompt tokens (system + user combined).
  maxPromptTokens: number;
  // Maximum allowed output tokens. Used to set max_tokens on the API call
  // AND to validate the response after the fact (a model that ignores the
  // max_tokens hint should still be caught).
  maxOutputTokens: number;
}

export const DEFAULT_AGENT_BUDGETS: Record<AgentStage, StageBudget> = {
  // PM canonicalizes user prose into ParsedSpec. Small in, small out.
  pm: { maxPromptTokens: 8_000, maxOutputTokens: 2_000 },
  // Architect reads repo context + spec; output is the architecture plan.
  architect: { maxPromptTokens: 16_000, maxOutputTokens: 4_000 },
  // Engineer is the heaviest stage — it sees the architecture plan plus
  // the relevant existing files and emits actual code diffs.
  engineer: { maxPromptTokens: 24_000, maxOutputTokens: 8_000 },
  // Review reads the diff + PR metadata and emits a summary.
  review: { maxPromptTokens: 12_000, maxOutputTokens: 4_000 },
};

export type AgentBudgetResult =
  | { ok: true; estimatedTokens: number }
  | {
      ok: false;
      reason: 'prompt-too-large' | 'output-too-large';
      stage: AgentStage;
      estimatedTokens: number;
      limit: number;
    };

// Approximate tokens-from-text. ~4 chars per token is the conventional rule
// of thumb for English + code mixes; we keep it deterministic and dependency-
// free so the budget check is pure and trivially testable.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function checkPromptBudget(
  stage: AgentStage,
  promptText: string,
  budgets: Record<AgentStage, StageBudget> = DEFAULT_AGENT_BUDGETS,
): AgentBudgetResult {
  const estimated = estimateTokens(promptText);
  const limit = budgets[stage].maxPromptTokens;
  if (estimated > limit) {
    return { ok: false, reason: 'prompt-too-large', stage, estimatedTokens: estimated, limit };
  }
  return { ok: true, estimatedTokens: estimated };
}

export function checkOutputBudget(
  stage: AgentStage,
  outputText: string,
  budgets: Record<AgentStage, StageBudget> = DEFAULT_AGENT_BUDGETS,
): AgentBudgetResult {
  const estimated = estimateTokens(outputText);
  const limit = budgets[stage].maxOutputTokens;
  if (estimated > limit) {
    return { ok: false, reason: 'output-too-large', stage, estimatedTokens: estimated, limit };
  }
  return { ok: true, estimatedTokens: estimated };
}

// Convenience: the value that should be passed as Anthropic's `max_tokens`
// for this stage. Centralizing here keeps the budget contract in one place.
export function maxTokensForStage(
  stage: AgentStage,
  budgets: Record<AgentStage, StageBudget> = DEFAULT_AGENT_BUDGETS,
): number {
  return budgets[stage].maxOutputTokens;
}
