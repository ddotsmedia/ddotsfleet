import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, RoleCode } from "../generated/prisma/client.js";

// Fixed UUIDs keep the seed idempotent across runs.
const id = (block: string, n: number): string =>
  `00000000-0000-4000-${block}-${n.toString(16).padStart(12, "0")}`;

export const DEMO_TENANT_ID = id("8000", 1);

const PERMISSIONS: Array<[string, string, string]> = [
  ["tenant:manage", "tenant", "manage"], ["membership:manage", "membership", "manage"],
  ["vehicle:read", "vehicle", "read"], ["vehicle:write", "vehicle", "write"],
  ["driver:read", "driver", "read"], ["driver:write", "driver", "write"],
  ["assignment:write", "assignment", "write"],
  ["document:read", "document", "read"], ["document:write", "document", "write"],
  ["maintenance:read", "maintenance", "read"], ["maintenance:write", "maintenance", "write"],
  ["expense:read", "expense", "read"], ["expense:write", "expense", "write"],
  ["shift:read", "shift", "read"], ["shift:write", "shift", "write"],
  ["checkout:write", "checkout", "write"], ["inspection:write", "inspection", "write"],
  ["trip:write", "trip", "write"], ["job:read", "job", "read"], ["job:write", "job", "write"],
  ["approval:review", "approval", "review"], ["report:read", "report", "read"],
  ["billing:manage", "billing", "manage"],
];

// Role -> permission codes (SRS section 3). company_admin receives every permission.
const ROLE_PERMISSIONS: Record<RoleCode, string[] | "all" | "read"> = {
  company_admin: "all",
  read_only_management: "read",
  fleet_manager: ["vehicle:read", "vehicle:write", "driver:read", "driver:write", "assignment:write",
    "document:read", "document:write", "maintenance:read", "job:read", "report:read"],
  dispatcher: ["job:read", "job:write", "trip:write", "vehicle:read", "driver:read", "shift:read"],
  maintenance_officer: ["maintenance:read", "maintenance:write", "inspection:write", "vehicle:read", "document:read"],
  finance_officer: ["expense:read", "expense:write", "approval:review", "report:read", "vehicle:read"],
  supervisor: ["shift:read", "approval:review", "vehicle:read", "driver:read", "job:read", "report:read"],
  driver: ["shift:write", "checkout:write", "inspection:write", "trip:write", "job:read", "expense:write", "vehicle:read"],
};

const ROLE_NAMES: Record<RoleCode, string> = {
  company_admin: "Company administrator", fleet_manager: "Fleet manager", dispatcher: "Dispatcher",
  maintenance_officer: "Maintenance officer", finance_officer: "Finance officer", supervisor: "Supervisor",
  driver: "Driver", read_only_management: "Read-only management",
};

export async function runSeed(prisma: PrismaClient): Promise<void> {
  await prisma.tenant.upsert({
    where: { id: DEMO_TENANT_ID },
    update: {},
    create: { id: DEMO_TENANT_ID, name: "Demo UAE Fleet", slug: "demo-uae" },
  });

  const permIds = new Map<string, string>();
  for (const [i, [code, resource, action]] of PERMISSIONS.entries()) {
    const p = await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { id: id("9000", i + 1), code, resource, action },
    });
    permIds.set(code, p.id);
  }

  for (const [i, code] of (Object.keys(ROLE_NAMES) as RoleCode[]).entries()) {
    const role = await prisma.role.upsert({
      where: { tenantId_roleCode: { tenantId: DEMO_TENANT_ID, roleCode: code } },
      update: {},
      create: { id: id("a000", i + 1), tenantId: DEMO_TENANT_ID, roleCode: code, name: ROLE_NAMES[code] },
    });
    const spec = ROLE_PERMISSIONS[code];
    const codes = spec === "all"
      ? [...permIds.keys()]
      : spec === "read"
        ? [...permIds.keys()].filter((c) => c.endsWith(":read"))
        : spec;
    await prisma.rolePermission.createMany({
      data: codes.map((c) => ({ roleId: role.id, permissionId: permIds.get(c)! })),
      skipDuplicates: true,
    });
  }
}

// Run directly: `pnpm --filter @fleetos/api db:seed`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  runSeed(prisma)
    .then(() => console.log("seed: ok"))
    .catch((e: unknown) => { console.error(e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
