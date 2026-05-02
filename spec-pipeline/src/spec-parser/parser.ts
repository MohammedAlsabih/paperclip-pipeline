import * as yaml from 'js-yaml';
import { ParsedSpec, ParsedSpecSchema, TechConstraints } from './schema';

interface FrontMatter {
  language?: string;
  framework?: string;
  auth_pattern?: string;
  test_coverage_required?: boolean;
  acceptance_criteria?: string[];
  file_hints?: string[];
}

function splitFrontMatter(input: string): { frontMatter: string | null; body: string } {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontMatter: null, body: input };
  }
  const end = trimmed.indexOf('\n---', 3);
  if (end === -1) {
    return { frontMatter: null, body: input };
  }
  const frontMatter = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 4).trimStart();
  return { frontMatter, body };
}

function extractAcceptanceCriteria(markdown: string): string[] {
  const criteria: string[] = [];
  // Match lines starting with "- " or "* " under an "Acceptance criteria" heading
  const acSection = markdown.match(/#+\s*acceptance criteria[\s\S]*?(?=\n#+|\n*$)/i);
  const sourceText = acSection ? acSection[0] : markdown;
  const listLines = sourceText.match(/^[\s]*[-*]\s+.+/gm) ?? [];
  for (const line of listLines) {
    const text = line.replace(/^[\s]*[-*]\s+/, '').trim();
    if (text) criteria.push(text);
  }
  return criteria;
}

function extractFeatureDescription(body: string): string {
  // First non-empty paragraph or heading content
  const lines = body.split('\n');
  const descLines: string[] = [];
  for (const line of lines) {
    const stripped = line.replace(/^#+\s*/, '').trim();
    if (!stripped) {
      if (descLines.length > 0) break;
      continue;
    }
    // Stop at a section that looks like metadata
    if (/^(acceptance criteria|file hints|constraints|tech constraints)/i.test(stripped)) break;
    descLines.push(stripped);
  }
  return descLines.join(' ').trim();
}

export function parseSpec(input: string): ParsedSpec {
  const { frontMatter, body } = splitFrontMatter(input);

  let fm: FrontMatter = {};
  if (frontMatter) {
    try {
      fm = (yaml.load(frontMatter) as FrontMatter) ?? {};
    } catch {
      // Ignore malformed front-matter; fall back to natural language only
    }
  }

  const techConstraints: TechConstraints = {
    language: fm.language ?? 'typescript',
    framework: fm.framework ?? 'express',
    auth_pattern: (fm.auth_pattern as TechConstraints['auth_pattern']) ?? 'jwt',
    test_coverage_required: fm.test_coverage_required ?? true,
  };

  // Acceptance criteria: prefer front-matter, then parse markdown body
  const acceptance_criteria =
    fm.acceptance_criteria && fm.acceptance_criteria.length > 0
      ? fm.acceptance_criteria
      : extractAcceptanceCriteria(body);

  const file_hints = fm.file_hints ?? [];

  const feature_description = extractFeatureDescription(body);

  return ParsedSpecSchema.parse({
    feature_description,
    tech_constraints: techConstraints,
    acceptance_criteria,
    file_hints,
    raw_markdown: input,
  });
}

export class SpecParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SpecParseError';
  }
}

export function parseSpecSafe(input: string): { ok: true; spec: ParsedSpec } | { ok: false; error: string } {
  try {
    return { ok: true, spec: parseSpec(input) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
