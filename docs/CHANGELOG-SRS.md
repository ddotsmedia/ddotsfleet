# SRS fine-tuning log (v1.1 -> v1.2 working baseline)

Source: FleetOS_SRS_v1.1.docx (15 Oct 2026). Source kept unchanged; deltas below are binding for implementation.

1. Task list numbering fixed: TASK 01–12 (source auto-numbered 13–24).
2. Auth gaps closed: add POST /api/v1/auth/login, POST /api/v1/auth/mfa/verify, POST /api/v1/auth/invitations/accept.
3. Missing list/read endpoints added: GET /api/v1/drivers/:id, GET/POST /api/v1/documents, GET/POST /api/v1/maintenance/work-orders, GET /api/v1/shifts, GET /api/v1/checkouts, GET /api/v1/trips, GET /api/v1/approvals. All list endpoints use cursor pagination.
4. Idempotency keys (header `Idempotency-Key`) required on: POST shifts/events, checkouts, trips, jobs/:id/events, expenses, webhooks, PWA sync.
5. Money precision: unit prices and fuel rates use NUMERIC(18,3); totals/tax NUMERIC(18,2). Currency default AED; VAT 5% configurable per tenant.
6. Inspections: S27 (P1 list) is merged into S50 (P0). P0 scope is S50 only.
7. Timezone: tenant timezone default Asia/Dubai; all storage UTC TIMESTAMPTZ.
8. Tooling baseline fixed: pnpm workspaces, Node 26, TypeScript strict, ESLint flat config, Prettier, NestJS 10, Next.js 14 (App Router), Prisma, Jest, Playwright.
9. Task 01 acceptance: pnpm install, lint, typecheck, unit tests, Docker compose up, /health/live and /health/ready return 200 on api and web, CI green.
10. Each task ships code + migration + tests + README note; no cross-module refactor in a single task.
11. Open decisions (section 18) remain open; none blocks Task 01–02.
