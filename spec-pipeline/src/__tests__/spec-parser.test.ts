import { parseSpec, parseSpecSafe } from '../spec-parser';
import * as fs from 'fs';
import * as path from 'path';

const DEMO_SPEC_PATH = path.join(__dirname, '../../demo/add-items-crud.md');

describe('parseSpec', () => {
  it('parses the demo spec end-to-end', () => {
    const raw = fs.readFileSync(DEMO_SPEC_PATH, 'utf-8');
    const spec = parseSpec(raw);

    expect(spec.feature_description).toContain('authenticated CRUD API');
    expect(spec.tech_constraints.language).toBe('typescript');
    expect(spec.tech_constraints.framework).toBe('express');
    expect(spec.tech_constraints.auth_pattern).toBe('jwt');
    expect(spec.tech_constraints.test_coverage_required).toBe(true);
    expect(spec.acceptance_criteria.length).toBeGreaterThanOrEqual(4);
    expect(spec.file_hints).toContain('src/middleware/jwt.ts');
    expect(spec.raw_markdown).toBe(raw);
  });

  it('parses natural language spec with no YAML front-matter', () => {
    const input = `Add a simple health check endpoint at GET /health that returns 200 OK.

## Acceptance criteria
- GET /health returns 200
- Response body is { status: "ok" }
`;
    const spec = parseSpec(input);

    expect(spec.feature_description).toContain('health check');
    expect(spec.tech_constraints.language).toBe('typescript');
    expect(spec.acceptance_criteria).toEqual(
      expect.arrayContaining(['GET /health returns 200'])
    );
    expect(spec.file_hints).toEqual([]);
  });

  it('uses front-matter tech constraints over defaults', () => {
    const input = `---
language: python
framework: fastapi
auth_pattern: api-key
---
Add a data export endpoint.`;
    const spec = parseSpec(input);

    expect(spec.tech_constraints.language).toBe('python');
    expect(spec.tech_constraints.framework).toBe('fastapi');
    expect(spec.tech_constraints.auth_pattern).toBe('api-key');
  });

  it('survives malformed YAML front-matter by falling back to defaults', () => {
    const input = `---
language: [broken yaml
framework:
---
Add a login endpoint.`;
    const result = parseSpecSafe(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.feature_description).toBeTruthy();
      expect(result.spec.tech_constraints.language).toBe('typescript');
    }
  });

  it('returns error for empty input', () => {
    const result = parseSpecSafe('');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });

  it('returns error for whitespace-only input', () => {
    const result = parseSpecSafe('   \n   \n  ');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });

  it('extracts acceptance criteria from markdown list without YAML', () => {
    const input = `Add pagination to GET /users.

## Acceptance criteria
- GET /users?page=1 returns first 20 results
- GET /users?page=2 returns next 20 results
- Missing page param defaults to page 1
`;
    const spec = parseSpec(input);

    expect(spec.acceptance_criteria).toContain('GET /users?page=1 returns first 20 results');
    expect(spec.acceptance_criteria.length).toBe(3);
  });

  it('merges file_hints from front-matter correctly', () => {
    const input = `---
file_hints:
  - src/routes/users.ts
  - src/models/user.ts
---
Add email verification to user registration.`;
    const spec = parseSpec(input);

    expect(spec.file_hints).toEqual(['src/routes/users.ts', 'src/models/user.ts']);
  });
});
