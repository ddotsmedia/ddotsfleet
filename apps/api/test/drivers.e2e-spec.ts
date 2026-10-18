import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type RoleCode } from "../src/generated/prisma/client.js";
import { AppModule } from "../src/app.module.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for driver tests");
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const suffix = Math.random().toString(36).slice(2, 10);
const PASSWORD = "correct horse battery";
const email = (tag: string) => `${tag}-${suffix}@test.local`;
const LICENCE_NUMBER = `LIC-${suffix}-SECRET`;

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

const validLicence = (expiresAt = "2030-01-01") => ({
  issuingCountry: "AE",
  licenceNumber: LICENCE_NUMBER,
  licenceClasses: ["b", "b"],
  expiresAt,
});

describe("drivers and assignments API", () => {
  let tenantA: string;
  let tenantB: string;
  let ownerA: string;
  let ownerB: string;
  let fleetA: string;
  let driverA: string;
  let vehicleA: string;
  let vehicleA2: string;
  let driverId: string;
  let driverId2: string;
  let assignmentId: string;

  const base = () => `/api/v1/tenants/${tenantA}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
    server = app.getHttpServer();

    ownerA = await sessionFor("drv-owner-a");
    ownerB = await sessionFor("drv-owner-b");
    tenantA = await createTenant(ownerA, `drv-a-${suffix}`);
    tenantB = await createTenant(ownerB, `drv-b-${suffix}`);
    fleetA = await sessionFor("drv-fleet-a");
    await addMember(tenantA, "drv-fleet-a", "fleet_manager");
    driverA = await sessionFor("drv-driver-a");
    await addMember(tenantA, "drv-driver-a", "driver");
    vehicleA = await createVehicle(tenantA, ownerA, `DRV ${suffix.slice(0, 4)} A`);
    vehicleA2 = await createVehicle(tenantA, ownerA, `DRV ${suffix.slice(0, 4)} B`);
  });

  afterAll(async () => {
    // Audit events are append-only by design, so their tenants are left in place. Suffixes keep runs isolated.
    await app.close();
    await prisma.$disconnect();
  });

  it("registers a driver with a normalised employee code", async () => {
    const res = await request(server)
      .post(`${base()}/drivers`)
      .set("Cookie", fleetA)
      .send({ employeeCode: `e-${suffix}`, fullName: "Ali Hassan", phone: "+971 50 123 4567" })
      .expect(201);
    expect(res.body.employeeCode).toBe(`E-${suffix}`.toUpperCase());
    driverId = res.body.id;
  });

  it("rejects a duplicate employee code", async () => {
    const res = await request(server)
      .post(`${base()}/drivers`)
      .set("Cookie", fleetA)
      .send({ employeeCode: `E-${suffix}`, fullName: "Other Person" })
      .expect(409);
    expect(res.body.message).toBe("driver_code_exists");
  });

  it("denies driver writes and listing to a driver-role member", async () => {
    await request(server)
      .post(`${base()}/drivers`)
      .set("Cookie", driverA)
      .send({ employeeCode: `X-${suffix}`, fullName: "Nope Nope" })
      .expect(403);
    await request(server).get(`${base()}/drivers`).set("Cookie", driverA).expect(403);
  });

  it("blocks a driver from another tenant reading this tenant's driver", async () => {
    await request(server).get(`${base()}/drivers/${driverId}`).set("Cookie", ownerB).expect(404);
    const other = await request(server)
      .get(`/api/v1/tenants/${tenantB}/drivers/${driverId}`)
      .set("Cookie", ownerB)
      .expect(404);
    expect(other.body.message).toBe("driver_not_found");
  });

  it("adds a licence and rejects a duplicate licence number", async () => {
    await request(server)
      .post(`${base()}/drivers/${driverId}/licences`)
      .set("Cookie", fleetA)
      .send(validLicence())
      .expect(201);
    await request(server)
      .post(`${base()}/drivers/${driverId}/licences`)
      .set("Cookie", fleetA)
      .send(validLicence())
      .expect(409);
  });

  it("does not put the licence number into the audit trail", async () => {
    const events = await prisma.auditEvent.findMany({
      where: { tenantId: tenantA, entityType: "driver_licence" },
    });
    expect(events.length).toBe(1);
    expect(JSON.stringify(events[0]!.changes)).not.toContain(LICENCE_NUMBER);
  });

  it("refuses an assignment without a valid licence unless an override reason is given", async () => {
    const other = await request(server)
      .post(`${base()}/drivers`)
      .set("Cookie", fleetA)
      .send({ employeeCode: `N-${suffix}`, fullName: "No Licence" })
      .expect(201);
    driverId2 = other.body.id;
    const res = await request(server)
      .post(`${base()}/assignments`)
      .set("Cookie", fleetA)
      .send({ vehicleId: vehicleA2, driverId: driverId2, startOdometer: 1000 })
      .expect(409);
    expect(res.body.message).toBe("licence_not_valid");
  });

  it("issues an assignment and blocks a second active assignment for the vehicle and driver", async () => {
    const res = await request(server)
      .post(`${base()}/assignments`)
      .set("Cookie", fleetA)
      .send({ vehicleId: vehicleA, driverId, startOdometer: 1000 })
      .expect(201);
    assignmentId = res.body.id;
    expect(res.body.status).toBe("active");

    const vehicleClash = await request(server)
      .post(`${base()}/assignments`)
      .set("Cookie", fleetA)
      .send({
        vehicleId: vehicleA,
        driverId: driverId2,
        startOdometer: 1000,
        licenceOverrideReason: "Temporary cover approved",
      })
      .expect(409);
    expect(vehicleClash.body.message).toBe("vehicle_already_assigned");

    const driverClash = await request(server)
      .post(`${base()}/assignments`)
      .set("Cookie", fleetA)
      .send({ vehicleId: vehicleA2, driverId, startOdometer: 1000 })
      .expect(409);
    expect(driverClash.body.message).toBe("driver_already_assigned");
  });

  it("blocks suspending a driver who holds an active assignment", async () => {
    const res = await request(server)
      .patch(`${base()}/drivers/${driverId}`)
      .set("Cookie", fleetA)
      .send({ status: "suspended" })
      .expect(409);
    expect(res.body.message).toBe("driver_has_active_assignment");
  });

  it("enforces the database partial unique index for active assignments", async () => {
    await expect(
      prisma.vehicleAssignment.create({
        data: {
          tenantId: tenantA,
          vehicleId: vehicleA,
          driverId: driverId2,
          startAt: new Date(),
          startOdometer: 1000,
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects closing with a lower odometer and then closes the assignment", async () => {
    await request(server)
      .post(`${base()}/assignments/${assignmentId}/end`)
      .set("Cookie", fleetA)
      .send({ endOdometer: 900 })
      .expect(409);

    const res = await request(server)
      .post(`${base()}/assignments/${assignmentId}/end`)
      .set("Cookie", fleetA)
      .send({ endOdometer: 1250 })
      .expect(201);
    expect(res.body.status).toBe("ended");
    expect(res.body.endOdometer).toBe(1250);

    await request(server)
      .post(`${base()}/assignments/${assignmentId}/end`)
      .set("Cookie", fleetA)
      .send({ endOdometer: 1300 })
      .expect(409);
  });

  it("refuses a new assignment whose opening odometer is below the vehicle's last reading", async () => {
    const res = await request(server)
      .post(`${base()}/assignments`)
      .set("Cookie", fleetA)
      .send({
        vehicleId: vehicleA,
        driverId: driverId2,
        startOdometer: 1100,
        licenceOverrideReason: "Temporary cover approved",
      })
      .expect(409);
    expect(res.body.message).toBe("odometer_decreased");
  });

  it("lists driver assignment history and hides foreign-tenant vehicles from issue", async () => {
    const list = await request(server)
      .get(`${base()}/assignments?driverId=${driverId}`)
      .set("Cookie", fleetA)
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].status).toBe("ended");

    const foreign = await createVehicle(tenantB, ownerB, `FOR ${suffix.slice(0, 4)} X`);
    const res = await request(server)
      .post(`${base()}/assignments`)
      .set("Cookie", fleetA)
      .send({
        vehicleId: foreign,
        driverId: driverId2,
        startOdometer: 0,
        licenceOverrideReason: "Temporary cover approved",
      })
      .expect(404);
    expect(res.body.message).toBe("vehicle_not_found");
  });

  it("keeps the driver's suspension path open once the assignment has ended", async () => {
    const res = await request(server)
      .patch(`${base()}/drivers/${driverId}`)
      .set("Cookie", fleetA)
      .send({ status: "suspended" })
      .expect(200);
    expect(res.body.status).toBe("suspended");
  });

  it("requires a session", async () => {
    await request(server).get(`${base()}/drivers`).expect(401);
  });
});
