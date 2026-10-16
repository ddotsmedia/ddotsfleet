import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, RoleCode } from "../src/generated/prisma/client.js";
import { runSeed, DEMO_TENANT_ID } from "../src/database/seed.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for tenancy tests");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const suffix = Math.random().toString(36).slice(2, 10);

async function makeTenant(tag: string) {
  return prisma.tenant.create({ data: { name: `T ${tag}`, slug: `${tag}-${suffix}` } });
}
async function makeUser(tag: string) {
  return prisma.user.create({ data: { email: `${tag}-${suffix}@test.local`, displayName: tag } });
}
async function makeRole(tenantId: string, code: RoleCode) {
  return prisma.role.create({ data: { tenantId, roleCode: code, name: code } });
}

describe("tenancy schema", () => {
  beforeAll(async () => { await prisma.$connect(); });

  afterAll(async () => {
    await prisma.grant.deleteMany({ where: { tenant: undefined, membership: { tenant: { slug: { endsWith: suffix } } } } });
    await prisma.tenantMembership.deleteMany({ where: { tenant: { slug: { endsWith: suffix } } } });
    await prisma.role.deleteMany({ where: { tenant: { slug: { endsWith: suffix } } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `${suffix}@test.local` } } });
    await prisma.tenant.deleteMany({ where: { slug: { endsWith: suffix } } });
    await prisma.$disconnect();
  });

  it("rejects a duplicate tenant slug", async () => {
    const t = await makeTenant("dup");
    await expect(prisma.tenant.create({ data: { name: "x", slug: t.slug } })).rejects.toThrow();
  });

  it("rejects a duplicate membership for the same tenant and user", async () => {
    const t = await makeTenant("mem");
    const u = await makeUser("mem");
    await prisma.tenantMembership.create({ data: { tenantId: t.id, userId: u.id } });
    await expect(prisma.tenantMembership.create({ data: { tenantId: t.id, userId: u.id } })).rejects.toThrow();
  });

  it("rejects a grant whose membership and role belong to different tenants", async () => {
    const a = await makeTenant("xa");
    const b = await makeTenant("xb");
    const u = await makeUser("xg");
    const m = await prisma.tenantMembership.create({ data: { tenantId: a.id, userId: u.id } });
    const roleB = await makeRole(b.id, RoleCode.driver);
    await expect(
      prisma.grant.create({ data: { tenantId: a.id, membershipId: m.id, roleId: roleB.id } }),
    ).rejects.toThrow();
  });

  it("accepts a same-tenant grant", async () => {
    const t = await makeTenant("ok");
    const u = await makeUser("ok");
    const m = await prisma.tenantMembership.create({ data: { tenantId: t.id, userId: u.id } });
    const r = await makeRole(t.id, RoleCode.supervisor);
    const g = await prisma.grant.create({ data: { tenantId: t.id, membershipId: m.id, roleId: r.id } });
    expect(g.id).toBeTruthy();
  });

  it("blocks deleting a tenant that still has memberships", async () => {
    const t = await makeTenant("del");
    const u = await makeUser("del");
    await prisma.tenantMembership.create({ data: { tenantId: t.id, userId: u.id } });
    await expect(prisma.tenant.delete({ where: { id: t.id } })).rejects.toThrow();
  });

  it("rejects an invalid enum value at the database level", async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO tenants (id, name, slug, status, updated_at)
        VALUES (gen_random_uuid(), 'bad', ${`bad-${suffix}`}, 'bogus'::"TenantStatus", now())`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`INSERT INTO tenants (id, name, slug, status, updated_at)
        VALUES (gen_random_uuid(), 'bad', ${`bad2-${suffix}`}, 'bogus', now())`,
    ).rejects.toThrow();
  });

  it("seed is idempotent", async () => {
    await runSeed(prisma);
    const count = () => Promise.all([prisma.permission.count(), prisma.role.count({ where: { tenantId: DEMO_TENANT_ID } }), prisma.rolePermission.count()]);
    const first = await count();
    await runSeed(prisma);
    expect(await count()).toEqual(first);
    expect(first[1]).toBe(8);
  });
});
