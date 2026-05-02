# Demo Target Repo

**URL:** https://github.com/MohammedAlsabih/spec-pipeline-demo-app  
**Branch:** `master`  
**Language:** TypeScript  
**Framework:** Express  
**Auth:** JWT (`src/middleware/jwt.ts`)

## Structure

```
src/
  app.ts                   — route registration (codegen patches here)
  middleware/jwt.ts         — JWT verify + signToken helper
  routes/users.ts           — GET /users, GET /users/:id (authenticated)
  __tests__/users.test.ts   — supertest integration tests
```

## Demo spec

The pipeline produces a diff adding:
- `src/routes/items.ts` — authenticated CRUD for `/items`
- `src/routes/__tests__/items.test.ts` — tests for create, delete, and 401 unauthenticated
- Patch to `src/app.ts` — registers the items router

## CI

GitHub Actions on every push: `typecheck + test` — passes on base branch.
