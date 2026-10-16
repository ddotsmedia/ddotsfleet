# FleetOS tooling and stack (verified 15 Oct 2026)

Versions below are the latest stable on npm/registries at this date. Packages published within pnpm's 24h `minimumReleaseAge` window are pinned to the newest version that clears it (noted).

## Runtime and platform
| Item | Version | Note |
|---|---|---|
| Node.js | 26.x (Docker `node:26-alpine`) | `.nvmrc`, `engines` |
| pnpm | 12.11.2 | `packageManager`; build-script allowlist in `pnpm-workspace.yaml` (`allowBuilds`) |
| TypeScript | 6.0.3 | TS 7.0.2 is out but Nest/Next/typescript-eslint peers still reject it; move when peers accept |
| PostgreSQL | 18 | compose + CI |
| Redis | 8 | compose; BullMQ queues |

## Backend (apps/api, ESM, NestJS 12)
- @nestjs/core, common, platform-express, config 12.1.3 / 12.0.1 (core pinned 12.1.3)
- @nestjs/swagger 12.0.2: generated OpenAPI (required by SRS section 9)
- @nestjs/bullmq 12.0.0 + bullmq 6.3.15: jobs (renewals, reminders, imports, webhooks)
- @nestjs/throttler 6.7.1: rate limits on auth and billing
- helmet 8.3.0: security headers (SRS section 10)
- nestjs-pino 5.3.1 + pino 10.4.0: structured logs with redaction of sensitive fields
- zod 4.6.7: DTO and env validation, shared with packages/types
- prisma 7.10.0 + @prisma/client 7.10.0: ORM and migrations (Task 02)
- @aws-sdk/client-s3 + s3-request-presigner 3.1151.0: private S3, signed URLs (3.1152.0 pending release-age cutoff)
- @sentry/node 11.8.0: error monitoring
- Tests: vitest 5.0.5 + unplugin-swc 2.0.0 (required: @nestjs/testing 12 is ESM-only; Jest cannot load it), supertest 7.3.1

## Frontend (apps/web, Next.js 16)
- next 16.4.0 (16.4.1 pending release-age cutoff), react / react-dom 19.3.1
- tailwindcss 4.3.3 + @tailwindcss/postcss 4.3.3
- @tanstack/react-query 5.104.3: server state, offline mutation queue hooks
- next-intl 4.14.9: English now, Arabic/RTL ready (SRS section 11)
- serwist 9.5.13 + @serwist/next 9.5.13: PWA service worker for driver offline mode (E12)
- @sentry/nextjs 11.8.0
- shadcn 4.21.5 CLI: UI components (from Task 03)

## Quality and dev tooling (root)
- eslint 10.12.0 (flat config), @eslint/js 10.0.1, typescript-eslint 8.71.2, prettier 3.9.10
- husky 9.1.7 + lint-staged 17.6.0: pre-commit lint/format
- @playwright/test 1.64.1: E2E, including cross-tenant tests in E15 (install browsers in CI)

## Recommended, not yet installed (add in the task that needs them)
- Testcontainers (real Postgres for RLS and isolation tests): Task 02/04
- Gitleaks, OSV-scanner or `pnpm audit`, CodeQL, Trivy image scan, Dependabot or Renovate: add to CI in Task 01 follow-up
- ClamAV sidecar for upload malware scanning (SRS section 9): E06
- Dockerized GitHub Actions deploy (ghcr.io) per the CI/CD template: after Task 01 is green
