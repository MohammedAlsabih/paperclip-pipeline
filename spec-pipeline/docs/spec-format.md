# Spec Format

A pipeline spec is a markdown file with an optional YAML front-matter block.

## Structure

```markdown
---
language: typescript           # default: typescript
framework: express             # default: express
auth_pattern: jwt              # default: jwt | options: jwt, session, api-key, none
test_coverage_required: true   # default: true
acceptance_criteria:           # optional; if omitted, parsed from markdown body
  - Description of criteria 1
  - Description of criteria 2
file_hints:                    # optional; files the spec author thinks are relevant
  - src/routes/
  - src/middleware/jwt.ts
---

Natural language description of the feature.

## Acceptance criteria       ← parsed if not in front-matter

- Criterion 1
- Criterion 2
```

## Output schema

```typescript
{
  feature_description: string;        // first paragraph/heading of body
  tech_constraints: {
    language: string;
    framework: string;
    auth_pattern: 'jwt' | 'session' | 'api-key' | 'none';
    test_coverage_required: boolean;
  };
  acceptance_criteria: string[];
  file_hints: string[];
  raw_markdown: string;               // original input, passed through unchanged
}
```

## Example

See `demo/add-items-crud.md` for the locked demo spec.
