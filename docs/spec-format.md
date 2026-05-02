# Spec Input Format

A spec is a plain text file submitted by the user to describe the feature they want built. It combines structured constraints (YAML front-matter) with a natural-language description (Markdown body).

## Structure

```
---
target_language: typescript
framework: express
auth_pattern: jwt
test_coverage_required: true
file_hints:
  - src/routes/items.ts
  - src/middleware/auth.ts
---

Natural language description of the feature. This is the primary input —
write it as you would describe a ticket to a developer. Acceptance criteria
can be listed as bullets or inlined in the prose.

- Returns 401 if unauthenticated
- Validates request body with zod
```

## Front-matter fields

| Field | Type | Required | Description |
|---|---|---|---|
| `target_language` | string | yes | Programming language (e.g. `typescript`, `python`) |
| `framework` | string | yes | Web framework (e.g. `express`, `fastapi`, `rails`) |
| `auth_pattern` | string | yes | Auth strategy (e.g. `jwt`, `session`, `api_key`, `none`) |
| `test_coverage_required` | boolean | no | Whether tests are expected. Defaults to `false`. |
| `file_hints` | string[] | no | Paths the user thinks are relevant. Passed as hints to the code generator. |

## Body

The body is free-form Markdown. The parser:
1. Uses the entire body as `feature_description`.
2. Extracts list items (`-` or `*` bullets, or numbered lists) as `acceptance_criteria`.

If there is no front-matter, the entire document is treated as the body and `tech_constraints` will be empty (the pipeline will prompt for them or apply defaults).

## Example — add authenticated CRUD route

```
---
target_language: typescript
framework: express
auth_pattern: jwt
test_coverage_required: true
file_hints:
  - src/middleware/auth.ts
---

Add an authenticated CRUD API for items. Auth is JWT. Use the existing middleware. Add tests for create and delete. Return 401 if unauthenticated.

- GET /items returns all items for the authenticated user
- POST /items creates a new item
- PUT /items/:id updates an item owned by the user
- DELETE /items/:id deletes an item owned by the user
- Returns 401 if no valid JWT is present
```

## Natural-language-only (no front-matter)

The parser also accepts plain prose with no YAML block. In this case `tech_constraints` is empty and `file_hints` is `[]`. Downstream steps are responsible for resolving the missing constraints.

```
Add an authenticated CRUD API for items using JWT. Tests required for create and delete.
```
