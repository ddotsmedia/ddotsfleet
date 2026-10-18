import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type RoleCode } from "../src/generated/prisma/client.js";
import { AppModule } from "../src/app.module.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for operations tests");
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
  return user.id;
}

async function createVehicle(tenantId: string, cookie: string, plate: string): Promise<string> {
  const res = await request(server)
    .post(`/api/v1/tenants/${tenantId}/vehicles`)
    .set("Cookie", cookie)
    .send({
      plateNumber: plate,
      emirate: "dubai",
      category: "Sedan",
      make: "Toyota",
      model: "Camry",
      fuelType: "petrol",
      ownership: "leased",
    })
    .expect(201);
  return res.body.id as string;
}

async function createDriver(tenantId: string, cookie: string, code: string): Promise<string> {
  const res = await request(server)
    .post(`/api/v1/tenants/${tenantId}/drivers`)
    .set("Cookie", cookie)
    .send({ employeeCode: code, fullName: `Driver ${code}` })
    .expect(201);
  return res.body.id as string;
}

describe("shifts, break events, checkouts and inspections", () => {
  let tenantA: string;
  let ownerA: string;
  let ownerB: string;
  let driverUserCookie: string;
  let readOnlyCookie: string;
  let driverLinked: string; // D1, linked to driverUserCookie's user
  let driverUnlinked: string; // D2, not linked to anyone
  let vehicle1: string;
  let vehicle2: string;
  let shiftId: string;
  let checkoutId: string;
  const base = () => `/api/v1/tenants/${tenantA}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
    server = app.getHttpServer();

    ownerA = await sessionFor("ops-owner-a");
    ownerB = await sessionFor("ops-owner-b");
    tenantA = await createTenant(ownerA, `ops-a-${suffix}`);
    await createTenant(ownerB, `ops-b-${suffix}`);

    const driverCookieTag = "ops-driver-a";
    driverUserCookie = await sessionFor(driverCookieTag);
    const driverUserId = await addMember(tenantA, driverCookieTag, "driver");
    readOnlyCookie = await sessionFor("ops-readonly-a");
    await addMember(tenantA, "ops-readonly-a", "read_only_management");

    driverLinked = await createDriver(tenantA, ownerA, `OPS-${suffix}-1`);
    driverUnlinked = await createDriver(tenantA, ownerA, `OPS-${suffix}-2`);
    await request(server)
      .patch(`${base()}/drivers/${driverLinked}`)
      .set("Cookie", ownerA)
      .send({ linkedUserId: driverUserId })
      .expect(200);

    vehicle1 = await createVehicle(tenantA, ownerA, `OPS ${suffix.slice(0, 4)} 1`);
    vehicle2 = await createVehicle(tenantA, ownerA, `OPS ${suffix.slice(0, 4)} 2`);
  });

  afterAll(async () => {
    // Audit events are append-only by design, so tenants are left in place. Suffixes keep runs isolated.
    await app.close();
    await prisma.$disconnect();
  });

  it("rejects linking a driver to a user who is not an active member", async () => {
    const stranger = await prisma.user.create({
      data: { email: email("ops-stranger"), passwordHash: "x", displayName: "stranger" },
    });
    await request(server)
      .patch(`${base()}/drivers/${driverUnlinked}`)
      .set("Cookie", ownerA)
      .send({ linkedUserId: stranger.id })
      .expect(400);
  });

  it("lets a linked driver start a shift for themselves and blocks acting for another driver", async () => {
    const res = await request(server)
      .post(`${base()}/shifts`)
      .set("Cookie", driverUserCookie)
      .send({ driverId: driverLinked })
      .expect(201);
    shiftId = res.body.id;
    expect(res.body.status).toBe("open");

    await request(server)
      .post(`${base()}/shifts`)
      .set("Cookie", driverUserCookie)
      .send({ driverId: driverUnlinked })
      .expect(403);
  });

  it("allows only one open shift per driver", async () => {
    await request(server)
      .post(`${base()}/shifts`)
      .set("Cookie", ownerA)
      .send({ driverId: driverLinked })
      .expect(409);
  });

  it("enforces break state transitions and is idempotent on clientRef", async () => {
    await request(server)
      .post(`${base()}/shifts/${shiftId}/events`)
      .set("Cookie", driverUserCookie)
      .send({ eventType: "break_end" })
      .expect(409);

    const start = await request(server)
      .post(`${base()}/shifts/${shiftId}/events`)
      .set("Cookie", driverUserCookie)
      .send({ eventType: "break_start", clientRef: `brk-${suffix}` })
      .expect(201);

    await request(server)
      .post(`${base()}/shifts/${shiftId}/events`)
      .set("Cookie", driverUserCookie)
      .send({ eventType: "break_start" })
      .expect(409);

    const retry = await request(server)
      .post(`${base()}/shifts/${shiftId}/events`)
      .set("Cookie", driverUserCookie)
      .send({ eventType: "break_start", clientRef: `brk-${suffix}` })
      .expect(201);
    expect(retry.body.id).toBe(start.body.id);

    await request(server)
      .post(`${base()}/shifts/${shiftId}/end`)
      .set("Cookie", driverUserCookie)
      .send({})
      .expect(409);

    await request(server)
      .post(`${base()}/shifts/${shiftId}/events`)
      .set("Cookie", driverUserCookie)
      .send({ eventType: "break_end" })
      .expect(201);
  });

  it("enforces tenant isolation and permissions on shifts", async () => {
    await request(server).get(`${base()}/shifts`).set("Cookie", ownerB).expect(404);
    await request(server)
      .post(`${base()}/shifts`)
      .set("Cookie", ownerB)
      .send({ driverId: driverUnlinked })
      .expect(404);
    await request(server)
      .post(`${base()}/shifts`)
      .set("Cookie", readOnlyCookie)
      .send({ driverId: driverUnlinked })
      .expect(403);
    // The driver role has no shift:read, so it cannot list shifts.
    await request(server).get(`${base()}/shifts`).set("Cookie", driverUserCookie).expect(403);

    const list = await request(server).get(`${base()}/shifts`).set("Cookie", ownerA).expect(200);
    expect(list.body.items.map((s: { id: string }) => s.id)).toContain(shiftId);
  });

  it("opens and returns a checkout while enforcing one open per vehicle and per driver", async () => {
    const res = await request(server)
      .post(`${base()}/checkouts`)
      .set("Cookie", driverUserCookie)
      .send({
        vehicleId: vehicle1,
        driverId: driverLinked,
        shiftId,
        openingOdometer: 50_000,
        openingFuelPercent: 90,
      })
      .expect(201);
    checkoutId = res.body.id;

    await request(server)
      .post(`${base()}/checkouts`)
      .set("Cookie", ownerA)
      .send({
        vehicleId: vehicle1,
        driverId: driverUnlinked,
        openingOdometer: 50_000,
        openingFuelPercent: 90,
      })
      .expect(409);
    await request(server)
      .post(`${base()}/checkouts`)
      .set("Cookie", ownerA)
      .send({
        vehicleId: vehicle2,
        driverId: driverLinked,
        openingOdometer: 50_000,
        openingFuelPercent: 90,
      })
      .expect(409);

    await request(server)
      .post(`${base()}/checkouts/${checkoutId}/return`)
      .set("Cookie", driverUserCookie)
      .send({ closingOdometer: 49_000, closingFuelPercent: 40 })
      .expect(409);

    const returned = await request(server)
      .post(`${base()}/checkouts/${checkoutId}/return`)
      .set("Cookie", driverUserCookie)
      .send({ closingOdometer: 50_120, closingFuelPercent: 40 })
      .expect(201);
    expect(returned.body.status).toBe("returned");

    await request(server)
      .post(`${base()}/checkouts/${checkoutId}/return`)
      .set("Cookie", driverUserCookie)
      .send({ closingOdometer: 50_130, closingFuelPercent: 40 })
      .expect(409);
  });

  it("closes a shift once no break is open, then refuses further events", async () => {
    await request(server)
      .post(`${base()}/shifts/${shiftId}/end`)
      .set("Cookie", driverUserCookie)
      .send({})
      .expect(201);
    await request(server)
      .post(`${base()}/shifts/${shiftId}/events`)
      .set("Cookie", driverUserCookie)
      .send({ eventType: "break_start" })
      .expect(409);
  });

  it("validates inspections and makes failed items raise defects that block dispatch", async () => {
    await request(server)
      .post(`${base()}/inspections`)
      .set("Cookie", driverUserCookie)
      .send({
        vehicleId: vehicle1,
        kind: "pre_trip",
        items: [{ code: "brakes", label: "Brakes", answer: "fail" }],
      })
      .expect(400);

    const passOnly = await request(server)
      .post(`${base()}/inspections`)
      .set("Cookie", driverUserCookie)
      .send({
        vehicleId: vehicle1,
        checkoutId,
        kind: "post_trip",
        items: [{ code: "lights", label: "Lights", answer: "pass" }],
      })
      .expect(201);
    expect(passOnly.body.result).toBe("pass");

    const failed = await request(server)
      .post(`${base()}/inspections`)
      .set("Cookie", driverUserCookie)
      .send({
        vehicleId: vehicle1,
        kind: "pre_trip",
        clientRef: `insp-${suffix}`,
        items: [
          {
            code: "brakes",
            label: "Brakes",
            answer: "fail",
            severity: "critical",
            notes: "Soft pedal",
          },
          { code: "tyres", label: "Tyres", answer: "fail", severity: "minor" },
        ],
      })
      .expect(201);
    expect(failed.body.result).toBe("fail");

    const retry = await request(server)
      .post(`${base()}/inspections`)
      .set("Cookie", driverUserCookie)
      .send({
        vehicleId: vehicle1,
        kind: "pre_trip",
        clientRef: `insp-${suffix}`,
        items: [{ code: "brakes", label: "Brakes", answer: "fail", severity: "critical" }],
      })
      .expect(201);
    expect(retry.body.id).toBe(failed.body.id);

    const defects = await prisma.defect.count({
      where: { tenantId: tenantA, vehicleId: vehicle1, status: "open" },
    });
    expect(defects).toBe(2);

    await request(server)
      .post(`${base()}/checkouts`)
      .set("Cookie", ownerA)
      .send({
        vehicleId: vehicle1,
        driverId: driverUnlinked,
        openingOdometer: 50_200,
        openingFuelPercent: 80,
      })
      .expect(409);
  });

  it("unblocks dispatch once the critical defect is cleared with a note", async () => {
    const critical = await prisma.defect.findFirstOrThrow({
      where: { tenantId: tenantA, vehicleId: vehicle1, severity: "critical", status: "open" },
    });
    await request(server)
      .post(`${base()}/maintenance/defects/${critical.id}/clear`)
      .set("Cookie", ownerA)
      .send({ clearanceNote: "Brake pads replaced and bled" })
      .expect(201);

    const res = await request(server)
      .post(`${base()}/checkouts`)
      .set("Cookie", ownerA)
      .send({
        vehicleId: vehicle1,
        driverId: driverUnlinked,
        openingOdometer: 50_200,
        openingFuelPercent: 80,
      })
      .expect(201);
    expect(res.body.status).toBe("open");
  });
});
