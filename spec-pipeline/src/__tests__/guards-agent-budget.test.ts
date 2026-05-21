import {
  estimateTokens,
  checkPromptBudget,
  checkOutputBudget,
  maxTokensForStage,
  DEFAULT_AGENT_BUDGETS,
} from '../guards';

describe('agent-budget (T11 — per-stage prompt + output token caps)', () => {
  test('estimateTokens uses ~chars/4 heuristic and is monotonic', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(4000))).toBe(1000);
  });

  test('checkPromptBudget accepts a prompt under the stage cap', () => {
    const result = checkPromptBudget('pm', 'a'.repeat(100));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.estimatedTokens).toBe(25);
  });

  test('checkPromptBudget rejects a prompt over the engineer cap with reason+limit', () => {
    // Engineer cap is 24K tokens — feed it ~25K tokens worth of chars.
    const tooBig = 'a'.repeat(DEFAULT_AGENT_BUDGETS.engineer.maxPromptTokens * 4 + 100);
    const result = checkPromptBudget('engineer', tooBig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('prompt-too-large');
      expect(result.stage).toBe('engineer');
      expect(result.limit).toBe(DEFAULT_AGENT_BUDGETS.engineer.maxPromptTokens);
      expect(result.estimatedTokens).toBeGreaterThan(result.limit);
    }
  });

  test('checkOutputBudget rejects oversized model output with reason=output-too-large', () => {
    const tooBig = 'x'.repeat(DEFAULT_AGENT_BUDGETS.review.maxOutputTokens * 4 + 100);
    const result = checkOutputBudget('review', tooBig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('output-too-large');
      expect(result.stage).toBe('review');
    }
  });

  test('maxTokensForStage matches the configured output cap for each stage', () => {
    expect(maxTokensForStage('pm')).toBe(DEFAULT_AGENT_BUDGETS.pm.maxOutputTokens);
    expect(maxTokensForStage('architect')).toBe(DEFAULT_AGENT_BUDGETS.architect.maxOutputTokens);
    expect(maxTokensForStage('engineer')).toBe(DEFAULT_AGENT_BUDGETS.engineer.maxOutputTokens);
    expect(maxTokensForStage('review')).toBe(DEFAULT_AGENT_BUDGETS.review.maxOutputTokens);
  });

  test('caller-supplied budget overrides default', () => {
    const tinyBudget = {
      ...DEFAULT_AGENT_BUDGETS,
      pm: { maxPromptTokens: 1, maxOutputTokens: 1 },
    };
    const result = checkPromptBudget('pm', 'hello world', tinyBudget);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.limit).toBe(1);
  });
});
