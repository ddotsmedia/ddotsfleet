import type { Prisma, PrismaClient, RoleCode } from "../generated/prisma/client.js";

// Shared by the seed and tenant onboarding so both create identical role catalogs.
export type Tx = Prisma.TransactionClient | PrismaClient;

export const PERMISSIONS: Array<[string, string, string]> = [
  ["tenant:manage", "tenant", "manage"],
  ["membership:manage", "membership", "manage"],
  ["vehicle:read", "vehicle", "read"],
  ["vehicle:write", "vehicle", "write"],
  ["driver:read", "driver", "read"],
  ["driver:write", "driver", "write"],
  ["assignment:write", "assignment", "write"],
  ["document:read", "document", "read"],
  ["document:write", "document", "write"],
  ["maintenance:read", "maintenance", "read"],
  ["maintenance:write", "maintenance", "write"],
  ["expense:read", "expense", "read"],
  ["expense:write", "expense", "write"],
  ["shift:read", "shift", "read"],
  ["shift:write", "shift", "write"],
  ["checkout:write", "checkout", "write"],
  ["inspection:write", "inspection", "write"],
  ["trip:write", "trip", "write"],
  ["job:read", "job", "read"],
  ["job:write", "job", "write"],
  ["approval:review", "approval", "review"],
  ["report:read", "report", "read"],
  ["billing:manage", "billing", "manage"],
];

// Role -> permission codes (SRS section 3). company_admin receives every permission.
export const ROLE_PERMISSIONS: Record<RoleCode, string[] | "all" | "read"> = {
  company_admin: "all",
  read_only_management: "read",
  fleet_manager: [
    "vehicle:read",
    "vehicle:write",
    "driver:read",
    "driver:write",
    "assignment:write",
    "document:read",
    "document:write",
    "maintenance:read",
    "job:read",
    "report:read",
  ],
  dispatcher: ["job:read", "job:write", "trip:write", "vehicle:read", "driver:read", "shift:read"],
  maintenance_officer: [
    "maintenance:read",
    "maintenance:write",
    "inspection:write",
    "vehicle:read",
    "document:read",
  ],
  finance_officer: [
    "expense:read",
    "expense:write",
    "approval:review",
    "report:read",
    "vehicle:read",
  ],
  supervisor: [
    "shift:read",
    "approval:review",
    "vehicle:read",
    "driver:read",
    "job:read",
    "report:read",
  ],
  driver: [
    "shift:write",
    "checkout:write",
    "inspection:write",
    "trip:write",
    "job:read",
    "expense:write",
    "vehicle:read",
  ],
};

export const ROLE_NAMES: Record<RoleCode, string> = {
  company_admin: "Company administrator",
  fleet_manager: "Fleet manager",
  dispatcher: "Dispatcher",
  maintenance_officer: "Maintenance officer",
  finance_officer: "Finance officer",
  supervisor: "Supervisor",
  driver: "Driver",
  read_only_management: "Read-only management",
};

export type IdFactory = (index: number) => string | undefined;

/** Upserts the global permission catalog and returns code -> permission id. */
export async function ensurePermissionCatalog(
  tx: Tx,
  makeId?: IdFactory,
): Promise<Map<string, string>> {
  const permIds = new Map<string, string>();
  for (const [i, [code, resource, action]] of PERMISSIONS.entries()) {
    const p = await tx.permission.upsert({
      where: { code },
      update: {},
      create: { id: makeId?.(i), code, resource, action },
    });
    permIds.set(code, p.id);
  }
  return permIds;
}

/** Upserts the eight SRS roles for a tenant and links their permissions. Returns roleCode -> role id. */
export async function createTenantRoles(
  tx: Tx,
  tenantId: string,
  permIds: Map<string, string>,
  makeId?: IdFactory,
): Promise<Map<RoleCode, string>> {
  const roleIds = new Map<RoleCode, string>();
  for (const [i, code] of (Object.keys(ROLE_NAMES) as RoleCode[]).entries()) {
    const role = await tx.role.upsert({
      where: { tenantId_roleCode: { tenantId, roleCode: code } },
      update: {},
      create: { id: makeId?.(i), tenantId, roleCode: code, name: ROLE_NAMES[code] },
    });
    roleIds.set(code, role.id);
    const spec = ROLE_PERMISSIONS[code];
    const codes =
      spec === "all"
        ? [...permIds.keys()]
        : spec === "read"
          ? [...permIds.keys()].filter((c) => c.endsWith(":read"))
          : spec;
    await tx.rolePermission.createMany({
      data: codes.map((c) => ({ roleId: role.id, permissionId: permIds.get(c)! })),
      skipDuplicates: true,
    });
  }
  return roleIds;
}
