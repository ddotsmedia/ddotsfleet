# FleetOS

UAE-first multi-tenant commercial fleet management SaaS. Requirements baseline: `docs/FleetOS_SRS_v1.1.docx`; deltas: `docs/CHANGELOG-SRS.md`.

## Layout
apps/web (Next.js) · apps/api (NestJS) · apps/platform (platform admin, later) · packages/{ui,types,api-client} · database/ · infrastructure/ · tests/

## Commands
- `pnpm install`
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- `docker compose -f infrastructure/docker-compose.yml up --build`
- Health: `curl localhost:4000/health/ready`, `curl localhost:3000/api/health`

Stack and tool versions: `docs/TOOLING.md`.

Task 01 status: monorepo, CI, Docker stack, health endpoints. Next: Task 02 (tenancy schema).
