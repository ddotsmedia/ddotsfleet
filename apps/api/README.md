# @fleetos/api
NestJS REST API. Health: `GET /health/live`, `GET /health/ready`. Business routes under `/api/v1`.
Run: `pnpm --filter @fleetos/api dev` · Test: `pnpm --filter @fleetos/api test`

## Database (Prisma 7 + PostgreSQL 18)
- Schema: `database/schema.prisma`; migrations: `database/migrations/`; config: `apps/api/prisma.config.ts`
- Client is generated to `src/generated/prisma` (git-ignored) by `prisma generate`, run automatically by build, typecheck and test.
- Apply migrations: `DATABASE_URL=... pnpm --filter @fleetos/api db:deploy`
- Create a migration (local only): `pnpm --filter @fleetos/api db:migrate --name <name>`
- Seed demo tenant and roles (idempotent): `pnpm --filter @fleetos/api db:seed`
- Tests (need `DATABASE_URL` on a migrated DB): `pnpm --filter @fleetos/api test`
- Readiness: `GET /health/ready` reports `checks.database`.
