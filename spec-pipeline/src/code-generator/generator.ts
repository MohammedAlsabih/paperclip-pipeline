import Anthropic from '@anthropic-ai/sdk';
import { createTwoFilesPatch } from 'diff';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImplementationPlan } from '../architecture-proposer';
import { RepoContext } from '../repo-context';
import { ParsedSpec } from '../spec-parser';
import { CodegenOutput, CreatedFile, ModifiedFile } from './schema';

const MODEL = 'claude-sonnet-4-6';

// Path to tsc binary relative to this file (spec-pipeline/node_modules/.bin/tsc)
const TSC_BIN = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsc');

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function createFilePrompt(
  filePath: string,
  purpose: string,
  plan: ImplementationPlan,
  context: RepoContext,
  spec: ParsedSpec,
  previousError?: string,
): string {
  const relatedFiles = context.key_files
    .filter(f => !f.path.includes('test') && !f.path.includes('spec'))
    .slice(0, 4)
    .map(f => `### ${f.path}\n\`\`\`typescript\n${f.content.split('\n').slice(0, 80).join('\n')}\n\`\`\``)
    .join('\n\n');

  const interfaces = plan.interfaces
    .map(i => {
      const fields = i.fields.map(f => `  ${f.name}${f.optional ? '?' : ''}: ${f.type};`).join('\n');
      return `interface ${i.name} {\n${fields}\n}`;
    })
    .join('\n\n');

  const errorSection = previousError
    ? `\n## Previous output had errors — fix them\n\n\`\`\`\n${previousError}\n\`\`\`\n`
    : '';

  return `You are a senior TypeScript engineer. Write the complete contents of \`${filePath}\`.

Purpose: ${purpose}

## Full implementation plan context

${plan.summary}

Files to create: ${plan.files_to_create.map(f => f.path).join(', ')}
Files to modify: ${plan.files_to_modify.map(f => f.path).join(', ')}
Test cases to cover: ${plan.test_cases.join('; ')}

## Interfaces to use

\`\`\`typescript
${interfaces}
\`\`\`

## Existing repo context

Auth pattern: ${context.auth_pattern}
Test framework: ${context.test_framework}

${relatedFiles}

## Spec acceptance criteria

${spec.acceptance_criteria.map(c => `- ${c}`).join('\n')}
${errorSection}
## Instructions

- Write ONLY the file content — no markdown fences, no explanation
- Reuse the existing auth middleware (${spec.tech_constraints.auth_pattern}) — do NOT reimplement it
- Keep the file under 200 lines
- Match the code style of the existing files shown above
- Use TypeScript strict mode conventions
- ${filePath.includes('test') ? 'Use supertest + jest for tests; cover happy path AND 401 unauthenticated path' : 'Export the router as the default export'}

Output the file content now:`;
}

function modifyFilePrompt(
  filePath: string,
  changeDescription: string,
  currentContent: string,
  plan: ImplementationPlan,
  previousError?: string,
): string {
  const errorSection = previousError
    ? `\n## Previous output had errors — fix them\n\n\`\`\`\n${previousError}\n\`\`\`\n`
    : '';

  return `You are a senior TypeScript engineer. Modify \`${filePath}\` to: ${changeDescription}

## Current file content

\`\`\`typescript
${currentContent}
\`\`\`

## Change required

${changeDescription}

Context: this is part of implementing "${plan.summary}".
New files being added: ${plan.files_to_create.map(f => f.path).join(', ')}
${errorSection}
## Instructions

- Output ONLY the complete modified file content — no markdown fences, no explanation
- Make the minimal change needed: ${changeDescription}
- Preserve all existing code, comments, and formatting
- Add any new import/require statements before existing ones of the same type

Output the complete modified file content now:`;
}

// ---------------------------------------------------------------------------
// LLM wrapper
// ---------------------------------------------------------------------------

async function callLlm(client: Anthropic, prompt: string): Promise<string> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('');
}

export function stripFences(text: string): string {
  const match = text.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/m);
  if (match) return match[1];
  return text.trim();
}

function makePatch(filePath: string, oldContent: string, newContent: string): string {
  return createTwoFilesPatch(
    `a/${filePath}`,
    `b/${filePath}`,
    oldContent,
    newContent,
    '',
    '',
    { context: 3 }
  );
}

// ---------------------------------------------------------------------------
// Validation — syntax-level tsc check (--noResolve skips missing modules)
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateWithTsc(output: CodegenOutput): ValidationResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-validate-'));
  try {
    const allFiles: Array<{ path: string; content: string }> = [
      ...output.files_created,
      ...output.files_modified.map(f => ({ path: f.path, content: f.new_content })),
    ];

    for (const f of allFiles) {
      const fullPath = path.join(tmpDir, f.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, f.content, 'utf-8');
    }

    // noResolve: skip module resolution — we only check syntax and intra-file types
    const tsconfig = {
      compilerOptions: {
        target: 'ES2020',
        module: 'commonjs',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        noResolve: true,
      },
      include: ['./**/*.ts'],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify(tsconfig, null, 2),
    );

    execSync(`"${TSC_BIN}" --noEmit -p tsconfig.json`, {
      cwd: tmpDir,
      stdio: 'pipe',
    });

    return { ok: true };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    const raw = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');

    // Filter expected noise from --noResolve mode (unresolved module/name errors)
    const realErrors = raw
      .split('\n')
      .filter(l =>
        l.includes('error TS') &&
        !l.includes('TS2307') && // Cannot find module
        !l.includes('TS2304') && // Cannot find name (from unresolved import)
        !l.includes('TS1259') && // Module can only be default-imported
        !l.includes('TS1192'),   // Module has no default export
      )
      .slice(0, 8)
      .join('\n')
      .trim();

    return realErrors.length > 0
      ? { ok: false, error: realErrors }
      : { ok: true };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}

// ---------------------------------------------------------------------------
// Per-file generators (with retry on validation failure)
// ---------------------------------------------------------------------------

async function generateCreatedFile(
  f: { path: string; purpose: string },
  plan: ImplementationPlan,
  context: RepoContext,
  spec: ParsedSpec,
  client: Anthropic,
  maxAttempts = 2,
): Promise<CreatedFile> {
  let previousError: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const prompt = createFilePrompt(f.path, f.purpose, plan, context, spec, previousError);
    const raw = await callLlm(client, prompt);
    const content = stripFences(raw);

    const validation = validateWithTsc({ files_created: [{ path: f.path, content }], files_modified: [] });
    if (validation.ok || attempt === maxAttempts - 1) {
      return { path: f.path, content };
    }
    previousError = validation.error;
  }

  // Unreachable but satisfies TypeScript
  throw new Error(`Failed to generate ${f.path} after ${maxAttempts} attempts`);
}

async function generateModifiedFile(
  f: { path: string; change: string; line_hint?: number | null },
  plan: ImplementationPlan,
  context: RepoContext,
  client: Anthropic,
  maxAttempts = 2,
): Promise<ModifiedFile> {
  const keyFile = context.key_files.find(kf => kf.path === f.path);
  const originalContent = keyFile?.content ?? `// ${f.path} — original content not available`;
  let previousError: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const prompt = modifyFilePrompt(f.path, f.change, originalContent, plan, previousError);
    const raw = await callLlm(client, prompt);
    const newContent = stripFences(raw);

    const validation = validateWithTsc({
      files_created: [],
      files_modified: [{ path: f.path, original_content: originalContent, new_content: newContent, patch: '' }],
    });

    if (validation.ok || attempt === maxAttempts - 1) {
      const patch = makePatch(f.path, originalContent, newContent);
      return { path: f.path, original_content: originalContent, new_content: newContent, patch };
    }
    previousError = validation.error;
  }

  throw new Error(`Failed to generate modification for ${f.path} after ${maxAttempts} attempts`);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function generateCode(
  plan: ImplementationPlan,
  context: RepoContext,
  spec: ParsedSpec,
  options: { apiKey?: string } = {}
): Promise<CodegenOutput> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for code generator');

  const client = new Anthropic({ apiKey });

  const [files_created, files_modified] = await Promise.all([
    Promise.all(
      plan.files_to_create.map(f => generateCreatedFile(f, plan, context, spec, client))
    ),
    Promise.all(
      plan.files_to_modify.map(f => generateModifiedFile(f, plan, context, client))
    ),
  ]);

  return { files_created, files_modified };
}
