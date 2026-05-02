---
language: typescript
framework: express
auth_pattern: jwt
test_coverage_required: true
acceptance_criteria:
  - POST /items returns 201 with created item
  - GET /items returns 200 with item list
  - PUT /items/:id returns 200 with updated item
  - DELETE /items/:id returns 204
  - All routes return 401 if JWT is missing or invalid
file_hints:
  - src/middleware/jwt.ts
  - src/routes/
  - src/app.ts
---

Add an authenticated CRUD API for items. Auth is JWT. Use the existing middleware. Add tests for create and delete. Return 401 if unauthenticated.

## Acceptance criteria

- POST /items returns 201 with created item
- GET /items returns 200 with item list
- PUT /items/:id returns 200 with updated item
- DELETE /items/:id returns 204
- All routes return 401 if JWT is missing or invalid
