import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type RoleCode } from "../src/generated/prisma/client.js";
import { AppModule } from "../src/app.module.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for vehicle tests");
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const suffix = Math.random().toString(36).slice(2, 10);
const PASSWORD = "correct horse battery";
const email = (tag: string) => `${tag}-${suffix}@test.local`;

let app: INestApplication;
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

async function addMember(tenantId: string, tag: string, roleCode: RoleCode) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: email(tag) } });
  const membership = await prisma.tenantMembership.create({
    data: { tenantId, userId: user.id, status: "active", joinedAt: new Date() },
  });
  const role = await prisma.role.findUniqueOrThrow({
    where: { tenantId_roleCode: { tenantId, roleCode } },
  });
  await prisma.grant.create({ data: { tenantId, membershipId: membership.id, roleId: role.id } });
}

const vehicleBody = (plate: string, extra: Record<string, unknown> = {}) => ({
  plateNumber: plate,
  emirate: "dubai",
  category: "Sedan",
  make: "Toyota",
  model: "Camry",
  year: 2024,
  fuelType: "petrol",
  ownership: "leased",
  ...extra,
});

describe("vehicles API", () => {
  let tenantA: string;
  let tenantB: string;
  let ownerA: string;
  let ownerB: string;
  let fleetA: string;
  let driverA: string;
  let readOnlyA: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
    server = app.getHttpServer();

    ownerA = await sessionFor("veh-owner-a");
    ownerB = await sessionFor("veh-owner-b");
    tenantA = await createTenant(ownerA, `veh-a-${suffix}`);
    tenantB = await createTenant(ownerB, `veh-b-${suffix}`);
    fleetA = await sessionFor("veh-fleet-a");
    await addMember(tenantA, "veh-fleet-a", "fleet_manager");
    driverA = await sessionFor("veh-driver-a");
    await addMember(tenantA, "veh-driver-a", "driver");
    readOnlyA = await sessionFor("veh-ro-a");
    await addMember(tenantA, "veh-ro-a", "read_only_management");
  });

  afterAll(async () => {
    // Audit events are append-only by design, so their tenants are left in place. Suffixes keep runs isolated.
    await app.close();
    await prisma.$disconnect();
  });

  it("creates a vehicle, normalises the plate and writes an audit event", async () => {
    const res = await request(server)
      .post(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", fleetA)
      .send(vehicleBody("  dxb   a 12345 "))
      .expect(201);
    expect(res.body.plateNumber).toBe("DXB A 12345");
    expect(res.body.status).toBe("active");
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: res.body.id } });
    expect(audit).toMatchObject({ tenantId: tenantA, action: "create", entityType: "vehicle" });
  });

  it("rejects a duplicate plate within the tenant, regardless of case or spacing", async () => {
    await request(server)
      .post(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", fleetA)
      .send(vehicleBody("DXB A 12345"))
      .expect(409);
  });

  it("allows the same plate in a different tenant", async () => {
    await request(server)
      .post(`/api/v1/tenants/${tenantB}/vehicles`)
      .set("Cookie", ownerB)
      .send(vehicleBody("DXB A 12345"))
      .expect(201);
  });

  it("rejects a duplicate fleet code within the tenant", async () => {
    await request(server)
      .post(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", fleetA)
      .send(vehicleBody("SHJ B 1", { fleetCode: "FL-100" }))
      .expect(201);
    const res = await request(server)
      .post(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", fleetA)
      .send(vehicleBody("SHJ B 2", { fleetCode: "fl-100" }))
      .expect(409);
    expect(res.body.message).toBe("vehicle_fleet_code_exists");
  });

  it("enforces permissions: drivers and read-only users can read but not write", async () => {
    await request(server)
      .get(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", driverA)
      .expect(200);
    await request(server)
      .get(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", readOnlyA)
      .expect(200);
    await request(server)
      .post(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", driverA)
      .send(vehicleBody("AJM C 1"))
      .expect(403);
    await request(server)
      .post(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", readOnlyA)
      .send(vehicleBody("AJM C 2"))
      .expect(403);
  });

  it("paginates with a stable cursor and filters by status", async () => {
    const page1 = await request(server)
      .get(`/api/v1/tenants/${tenantA}/vehicles?limit=1`)
      .set("Cookie", ownerA)
      .expect(200);
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.nextCursor).toBe(page1.body.items[0].id);
    const page2 = await request(server)
      .get(`/api/v1/tenants/${tenantA}/vehicles?limit=100&cursor=${page1.body.nextCursor}`)
      .set("Cookie", ownerA)
      .expect(200);
    expect(page2.body.items.map((v: { id: string }) => v.id)).not.toContain(page1.body.items[0].id);

    const retired = await request(server)
      .get(`/api/v1/tenants/${tenantA}/vehicles?status=retired`)
      .set("Cookie", ownerA)
      .expect(200);
    expect(retired.body.items).toEqual([]);
  });

  it("keeps tenants separate: lists, reads and updates never cross", async () => {
    const listA = await request(server)
      .get(`/api/v1/tenants/${tenantA}/vehicles?limit=100`)
      .set("Cookie", ownerA)
      .expect(200);
    const bVehicle = await prisma.vehicle.findFirstOrThrow({ where: { tenantId: tenantB } });
    expect(listA.body.items.map((v: { id: string }) => v.id)).not.toContain(bVehicle.id);

    await request(server)
      .get(`/api/v1/tenants/${tenantA}/vehicles/${bVehicle.id}`)
      .set("Cookie", ownerA)
      .expect(404);
    await request(server)
      .patch(`/api/v1/tenants/${tenantA}/vehicles/${bVehicle.id}`)
      .set("Cookie", ownerA)
      .send({ colour: "red" })
      .expect(404);
    await request(server)
      .get(`/api/v1/tenants/${tenantB}/vehicles/${bVehicle.id}`)
      .set("Cookie", ownerA)
      .expect(404);
  });

  it("updates only changed fields, audits a from/to diff, and ignores body tenantId", async () => {
    const created = await request(server)
      .post(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", fleetA)
      .send(vehicleBody("RAK D 77"))
      .expect(201);
    const id = created.body.id as string;
    const before = await prisma.auditEvent.count({ where: { entityId: id } });

    const patched = await request(server)
      .patch(`/api/v1/tenants/${tenantA}/vehicles/${id}`)
      .set("Cookie", fleetA)
      .send({ colour: "white", status: "maintenance", tenantId: tenantB })
      .expect(200);
    expect(patched.body).toMatchObject({ colour: "white", status: "maintenance" });

    const row = await prisma.vehicle.findUniqueOrThrow({ where: { id } });
    expect(row.tenantId).toBe(tenantA);

    const events = await prisma.auditEvent.findMany({
      where: { entityId: id },
      orderBy: { createdAt: "asc" },
    });
    expect(events).toHaveLength(before + 1);
    const update = events[events.length - 1]!;
    expect(Object.keys(update.changes as object).sort()).toEqual(["colour", "status"]);
    expect(update.changes).toMatchObject({ status: { from: "active", to: "maintenance" } });
  });

  it("writes no audit event for a no-op update", async () => {
    const created = await request(server)
      .post(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", fleetA)
      .send(vehicleBody("RAK E 88"))
      .expect(201);
    const before = await prisma.auditEvent.count({ where: { entityId: created.body.id } });
    await request(server)
      .patch(`/api/v1/tenants/${tenantA}/vehicles/${created.body.id}`)
      .set("Cookie", fleetA)
      .send({ make: "Toyota" })
      .expect(200);
    expect(await prisma.auditEvent.count({ where: { entityId: created.body.id } })).toBe(before);
  });

  it("rejects an empty patch and invalid vehicle data", async () => {
    const created = await request(server)
      .post(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", fleetA)
      .send(vehicleBody("RAK F 99"))
      .expect(201);
    await request(server)
      .patch(`/api/v1/tenants/${tenantA}/vehicles/${created.body.id}`)
      .set("Cookie", fleetA)
      .send({})
      .expect(400);
    await request(server)
      .post(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", fleetA)
      .send(vehicleBody("AUH G 1", { emirate: "atlantis" }))
      .expect(400);
    await request(server)
      .post(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", fleetA)
      .send(vehicleBody("AUH G 2", { vin: "1HGBH41JXMN10918I" }))
      .expect(400);
    await request(server)
      .post(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", fleetA)
      .send(vehicleBody("AUH G 3", { year: 1800 }))
      .expect(400);
    await request(server)
      .get(`/api/v1/tenants/${tenantA}/vehicles/not-a-uuid`)
      .set("Cookie", fleetA)
      .expect(400);
  });

  it("requires a session", async () => {
    await request(server).get(`/api/v1/tenants/${tenantA}/vehicles`).expect(401);
  });

  it("makes audit events append-only at the database", async () => {
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: tenantA } });
    await expect(
      prisma.auditEvent.update({ where: { id: event.id }, data: { action: "tampered" } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow(
      /append-only/,
    );
  });
});
