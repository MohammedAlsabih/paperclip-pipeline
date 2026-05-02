import Anthropic from '@anthropic-ai/sdk';
import { ParsedSpec } from '../spec-parser';
import { RepoContext } from '../repo-context';
import { ImplementationPlan, ImplementationPlanSchema } from './schema';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 2048;

const SYSTEM_PROMPT = `You are a senior TypeScript engineer doing an architecture review.
Given a feature spec and the context of an existing codebase, produce a concrete implementation plan.
Output ONLY valid JSON that matches this exact schema — no markdown fences, no explanation:

{
  "summary": "one-sentence description of what will be implemented",
  "files_to_create": [
    { "path": "src/routes/items.ts", "purpose": "CRUD route handlers for items resource" }
  ],
  "files_to_modify": [
    { "path": "src/app.ts", "change": "register items router", "line_hint": 42 }
  ],
  "interfaces": [
    { "name": "Item", "fields": [{ "name": "id", "type": "string", "optional": false }] }
  ],
  "test_cases": [
    "POST /items returns 201 with created item",
    "DELETE /items/:id returns 204",
    "POST /items returns 401 without auth"
  ]
}

Rules:
- files_to_create: use the exact paths that fit the existing project structure
- files_to_modify: only include files that genuinely need changes for the new feature
- interfaces: only include new TypeScript interfaces the new code will need
- test_cases: write as HTTP assertions (method + path + expected outcome)
- Reuse existing patterns from the repo (auth middleware, router style, test style)`;

function buildUserPrompt(spec: ParsedSpec, context: RepoContext): string {
  const keyFilesSection = context.key_files
    .slice(0, 6)
    .map(f => {
      const contentPreview = f.content.split('\n').slice(0, 60).join('\n');
      const summary = f.summary ? `\n// Summary: ${f.summary}` : '';
      return `### ${f.path}${summary}\n\`\`\`typescript\n${contentPreview}\n\`\`\``;
    })
    .join('\n\n');

  const routeList = context.existing_routes
    .map(r => `  ${r.method} ${r.path}  (${r.file})`)
    .join('\n');

  return `## Feature spec

${spec.feature_description}

**Tech constraints:**
- Language: ${spec.tech_constraints.language}
- Framework: ${spec.tech_constraints.framework}
- Auth pattern: ${spec.tech_constraints.auth_pattern}
- Tests required: ${spec.tech_constraints.test_coverage_required}

**Acceptance criteria:**
${spec.acceptance_criteria.map(c => `- ${c}`).join('\n')}

**File hints from spec author:**
${spec.file_hints.length > 0 ? spec.file_hints.join(', ') : '(none)'}

---

## Existing repo: ${context.repo_url}

**File tree (relevant files):**
${context.file_tree.slice(0, 20).join('\n')}

**Existing routes:**
${routeList || '(none detected)'}

**Auth pattern detected:** ${context.auth_pattern}
**Test framework:** ${context.test_framework}

**Key source files:**

${keyFilesSection}

---

Produce the implementation plan JSON now.`;
}

function extractJson(text: string): string {
  // Strip markdown code fences if LLM ignores system prompt
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Find first { and last }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text.trim();
}

export class ArchProposerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchProposerError';
  }
}

export async function proposeArchitecture(
  spec: ParsedSpec,
  context: RepoContext,
  options: { apiKey?: string; maxRetries?: number } = {}
): Promise<ImplementationPlan> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for architecture proposer');

  const client = new Anthropic({ apiKey });
  const maxRetries = options.maxRetries ?? 1;
  const userPrompt = buildUserPrompt(spec, context);

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const retryNote = attempt > 0 && lastError instanceof Error
      ? `\n\nPrevious attempt failed validation: ${lastError.message}. Fix the JSON and try again.`
      : '';

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt + retryNote }],
    });

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('');

    try {
      const jsonStr = extractJson(rawText);
      const parsed = JSON.parse(jsonStr) as unknown;
      return ImplementationPlanSchema.parse(parsed);
    } catch (err) {
      lastError = err;
    }
  }

  throw new ArchProposerError(
    `Architecture proposer failed after ${maxRetries + 1} attempt(s): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
