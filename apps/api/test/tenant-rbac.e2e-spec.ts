import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type RoleCode } from "../src/generated/prisma/client.js";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import type { NestExpressApplication } from "@nestjs/platform-express";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for tenant RBAC tests");
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const suffix = Math.random().toString(36).slice(2, 10);
const PASSWORD = "correct horse battery";
const MISSING_TENANT = "00000000-0000-4000-8000-000000000999";

const email = (tag: string) => `${tag}-${suffix}@test.local`;
let app: NestExpressApplication;
let server: Parameters<typeof request>[0];

async function sessionFor(tag: string): Promise<string> {
  await request(server)
    .post("/api/v1/auth/register")
    .send({ email: email(tag), password: PASSWORD, displayName: tag })
    .expect(201);
  const res = await request(server)
    .post("/api/v1/auth/login")
    .send({ email: email(tag), password: PASSWORD })
    .expect(200);
  return res.headers["set-cookie"]![0]!.split(";")[0]!;
}

async function createTenant(cookie: string, slug: string): Promise<string> {
  const res = await request(server)
    .post("/api/v1/tenants")
    .set("Cookie", cookie)
    .send({ name: `Tenant ${slug}`, slug })
    .expect(201);
  return res.body.id as string;
}

/** Adds an existing user to a tenant with one role. Invitation flow is covered by auth-onboarding tests. */
async function addMember(
  tenantId: string,
  tag: string,
  roleCode: RoleCode,
  status: "active" | "suspended" | "removed" = "active",
) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: email(tag) } });
  const membership = await prisma.tenantMembership.create({
    data: { tenantId, userId: user.id, status, joinedAt: new Date() },
  });
  const role = await prisma.role.findUniqueOrThrow({
    where: { tenantId_roleCode: { tenantId, roleCode } },
  });
  const grant = await prisma.grant.create({
    data: { tenantId, membershipId: membership.id, roleId: role.id },
  });
  return { membershipId: membership.id, grantId: grant.id };
}

describe("tenant context, RBAC and cross-tenant isolation", () => {
  let tenantA: string;
  let tenantB: string;
  let ownerA: string;
  let ownerB: string;
  let fleetA: string;
  let readOnlyA: string;
  let suspendedA: string;
  let outsider: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();

    ownerA = await sessionFor("owner-a");
    ownerB = await sessionFor("owner-b");
    tenantA = await createTenant(ownerA, `rbac-a-${suffix}`);
    tenantB = await createTenant(ownerB, `rbac-b-${suffix}`);

    fleetA = await sessionFor("fleet-a");
    await addMember(tenantA, "fleet-a", "fleet_manager");
    readOnlyA = await sessionFor("ro-a");
    await addMember(tenantA, "ro-a", "read_only_management");
    suspendedA = await sessionFor("susp-a");
    await addMember(tenantA, "susp-a", "driver", "suspended");
    outsider = await sessionFor("outsider");
  });

  afterAll(async () => {
    const slugs = { endsWith: suffix };
    await prisma.invitation.deleteMany({ where: { tenant: { slug: slugs } } });
    await prisma.grant.deleteMany({ where: { membership: { tenant: { slug: slugs } } } });
    await prisma.tenantMembership.deleteMany({ where: { tenant: { slug: slugs } } });
    await prisma.rolePermission.deleteMany({ where: { role: { tenant: { slug: slugs } } } });
    await prisma.role.deleteMany({ where: { tenant: { slug: slugs } } });
    await prisma.tenant.deleteMany({ where: { slug: slugs } });
    await prisma.session.deleteMany({
      where: { user: { email: { endsWith: `${suffix}@test.local` } } },
    });
    await prisma.user.deleteMany({ where: { email: { endsWith: `${suffix}@test.local` } } });
    await prisma.$disconnect();
    await app.close();
  });

  it("requires a session for tenant-scoped reads", async () => {
    await request(server).get(`/api/v1/tenants/${tenantA}`).expect(401);
    await request(server).get(`/api/v1/tenants/${tenantA}/members`).expect(401);
  });

  it("returns the tenant to an active member", async () => {
    const res = await request(server)
      .get(`/api/v1/tenants/${tenantA}`)
      .set("Cookie", fleetA)
      .expect(200);
    expect(res.body).toMatchObject({ id: tenantA, status: "active" });
  });

  it("answers foreign and nonexistent tenants identically, so tenants cannot be enumerated", async () => {
    const foreign = await request(server)
      .get(`/api/v1/tenants/${tenantB}`)
      .set("Cookie", ownerA)
      .expect(404);
    const missing = await request(server)
      .get(`/api/v1/tenants/${MISSING_TENANT}`)
      .set("Cookie", ownerA)
      .expect(404);
    expect(foreign.body).toEqual(missing.body);
  });

  it("refuses non-members of a tenant, including on permission-protected routes", async () => {
    await request(server).get(`/api/v1/tenants/${tenantA}`).set("Cookie", outsider).expect(404);
    await request(server)
      .get(`/api/v1/tenants/${tenantA}/members`)
      .set("Cookie", outsider)
      .expect(404);
    await request(server)
      .post(`/api/v1/tenants/${tenantA}/invitations`)
      .set("Cookie", outsider)
      .send({ email: email("x-1"), roleCode: "driver" })
      .expect(404);
  });

  it("enforces permissions: company admins list members, fleet managers do not", async () => {
    const list = await request(server)
      .get(`/api/v1/tenants/${tenantA}/members`)
      .set("Cookie", ownerA)
      .expect(200);
    expect(list.body.map((m: { user: { email: string } }) => m.user.email)).toEqual(
      expect.arrayContaining([email("owner-a"), email("fleet-a"), email("ro-a")]),
    );
    await request(server)
      .get(`/api/v1/tenants/${tenantA}/members`)
      .set("Cookie", fleetA)
      .expect(403);
  });

  it("gives read-only management only read permissions and blocks writes", async () => {
    const access = await request(server)
      .get(`/api/v1/tenants/${tenantA}/access`)
      .set("Cookie", readOnlyA)
      .expect(200);
    expect(access.body.roleCodes).toEqual(["read_only_management"]);
    expect(access.body.permissions.length).toBeGreaterThan(0);
    expect(access.body.permissions.every((p: string) => p.endsWith(":read"))).toBe(true);
    await request(server)
      .post(`/api/v1/tenants/${tenantA}/invitations`)
      .set("Cookie", readOnlyA)
      .send({ email: email("x-2"), roleCode: "driver" })
      .expect(403);
  });

  it("ignores a tenant_id supplied in the body; the path tenant is the only scope", async () => {
    await request(server)
      .post(`/api/v1/tenants/${tenantA}/invitations`)
      .set("Cookie", ownerA)
      .send({ tenantId: tenantB, email: email("body-scope"), roleCode: "driver" })
      .expect(201);
    const inv = await prisma.invitation.findFirstOrThrow({ where: { email: email("body-scope") } });
    expect(inv.tenantId).toBe(tenantA);
  });

  it("denies suspended memberships and suspended tenants on the next request", async () => {
    await request(server).get(`/api/v1/tenants/${tenantA}`).set("Cookie", suspendedA).expect(403);

    await prisma.tenant.update({ where: { id: tenantA }, data: { status: "suspended" } });
    try {
      await request(server).get(`/api/v1/tenants/${tenantA}`).set("Cookie", ownerA).expect(403);
    } finally {
      await prisma.tenant.update({ where: { id: tenantA }, data: { status: "active" } });
    }
    await request(server).get(`/api/v1/tenants/${tenantA}`).set("Cookie", ownerA).expect(200);
  });

  it("applies revoked grants on the next request", async () => {
    const promoted = await sessionFor("revoke-a");
    const { grantId } = await addMember(tenantA, "revoke-a", "company_admin");
    await request(server)
      .get(`/api/v1/tenants/${tenantA}/members`)
      .set("Cookie", promoted)
      .expect(200);

    await prisma.grant.delete({ where: { id: grantId } });
    await request(server)
      .get(`/api/v1/tenants/${tenantA}/members`)
      .set("Cookie", promoted)
      .expect(403);
  });

  it("keeps grants inside one tenant: an admin of A has no rights in B", async () => {
    await request(server)
      .get(`/api/v1/tenants/${tenantB}/members`)
      .set("Cookie", ownerA)
      .expect(404);
    const members = await request(server)
      .get(`/api/v1/tenants/${tenantB}/members`)
      .set("Cookie", ownerB)
      .expect(200);
    expect(members.body.map((m: { user: { email: string } }) => m.user.email)).not.toContain(
      email("fleet-a"),
    );
  });

  it("rejects malformed tenant ids before any lookup", async () => {
    await request(server).get("/api/v1/tenants/not-a-uuid").set("Cookie", ownerA).expect(400);
  });
});
