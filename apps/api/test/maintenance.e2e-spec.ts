import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type RoleCode } from "../src/generated/prisma/client.js";
import { AppModule } from "../src/app.module.js";
import { MaintenanceService } from "../src/maintenance/maintenance.service.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for maintenance tests");
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

const isoToday = () => new Date().toISOString().slice(0, 10);

describe("maintenance plans, work orders, service history and defects", () => {
  let tenantA: string;
  let tenantB: string;
  let ownerA: string;
  let ownerB: string;
  let officerA: string;
  let driverA: string;
  let fleetA: string;
  let vehicleA: string;
  let vehicleOther: string;
  let planA: string;
  let woCompleted: string;
  let woForCancel: string;
  let criticalDefect: string;

  const base = () => `/api/v1/tenants/${tenantA}/maintenance`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
    server = app.getHttpServer();

    ownerA = await sessionFor("mnt-owner-a");
    ownerB = await sessionFor("mnt-owner-b");
    tenantA = await createTenant(ownerA, `mnt-a-${suffix}`);
    tenantB = await createTenant(ownerB, `mnt-b-${suffix}`);
    officerA = await sessionFor("mnt-officer-a");
    await addMember(tenantA, "mnt-officer-a", "maintenance_officer");
    driverA = await sessionFor("mnt-driver-a");
    await addMember(tenantA, "mnt-driver-a", "driver");
    fleetA = await sessionFor("mnt-fleet-a");
    await addMember(tenantA, "mnt-fleet-a", "fleet_manager");
    vehicleA = await createVehicle(tenantA, ownerA, `MNT ${suffix.slice(0, 4)} A`);
    vehicleOther = await createVehicle(tenantA, ownerA, `MNT ${suffix.slice(0, 4)} B`);
  });

  afterAll(async () => {
    // Audit events are append-only by design, so their tenants are left in place. Suffixes keep runs isolated.
    await app.close();
    await prisma.$disconnect();
  });

  it("creates a plan with a km and day interval", async () => {
    const res = await request(server)
      .post(`${base()}/plans`)
      .set("Cookie", officerA)
      .send({ vehicleId: vehicleA, name: "Oil service", intervalKm: 10000, intervalDays: 180 })
      .expect(201);
    planA = res.body.id;
    expect(res.body.status).toBe("active");
  });

  it("rejects a plan with no interval", async () => {
    const res = await request(server)
      .post(`${base()}/plans`)
      .set("Cookie", officerA)
      .send({ vehicleId: vehicleA, name: "No interval" })
      .expect(400);
    expect(res.body.message).toBe("invalid_input");
  });

  it("blocks the fleet manager from writing maintenance but lets them read it", async () => {
    await request(server)
      .post(`${base()}/work-orders`)
      .set("Cookie", fleetA)
      .send({ vehicleId: vehicleA, title: "Brake pads" })
      .expect(403);
    await request(server).get(`${base()}/plans`).set("Cookie", fleetA).expect(200);
  });

  it("refuses a work order that links a plan from another vehicle", async () => {
    const res = await request(server)
      .post(`${base()}/work-orders`)
      .set("Cookie", officerA)
      .send({ vehicleId: vehicleOther, planId: planA, title: "Oil change" })
      .expect(404);
    expect(res.body.message).toBe("plan_not_found");
  });

  it("enforces separation of duties on approval", async () => {
    const wo = await request(server)
      .post(`${base()}/work-orders`)
      .set("Cookie", officerA)
      .send({
        vehicleId: vehicleA,
        planId: planA,
        title: "Oil change",
        vendorName: "Dubai Garage",
        labourFils: 15000,
        partsFils: 45000,
      })
      .expect(201);
    woCompleted = wo.body.id;
    expect(wo.body.status).toBe("open");

    const self = await request(server)
      .post(`${base()}/work-orders/${woCompleted}/approve`)
      .set("Cookie", officerA)
      .expect(403);
    expect(self.body.message).toBe("self_approval_forbidden");

    const approved = await request(server)
      .post(`${base()}/work-orders/${woCompleted}/approve`)
      .set("Cookie", ownerA)
      .expect(201);
    expect(approved.body.status).toBe("approved");
  });

  it("completes the work order, writes service history and recalculates the plan", async () => {
    const res = await request(server)
      .post(`${base()}/work-orders/${woCompleted}/complete`)
      .set("Cookie", officerA)
      .send({ odometer: 50000, serviceOn: isoToday(), invoiceNumber: "INV-100" })
      .expect(201);
    expect(res.body.status).toBe("completed");

    const history = await request(server)
      .get(`${base()}/service-history?vehicleId=${vehicleA}`)
      .set("Cookie", officerA)
      .expect(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0]).toMatchObject({
      odometer: 50000,
      labourFils: 15000,
      partsFils: 45000,
      invoiceNumber: "INV-100",
    });

    const plan = await prisma.maintenancePlan.findUniqueOrThrow({ where: { id: planA } });
    expect(plan.nextDueOdometer).toBe(60000);
    expect(plan.nextDueDate).not.toBeNull();
  });

  it("refuses to complete a work order with an odometer below the last service", async () => {
    const wo = await request(server)
      .post(`${base()}/work-orders`)
      .set("Cookie", officerA)
      .send({ vehicleId: vehicleA, title: "Filter change" })
      .expect(201);
    await request(server)
      .post(`${base()}/work-orders/${wo.body.id}/approve`)
      .set("Cookie", ownerA)
      .expect(201);
    const res = await request(server)
      .post(`${base()}/work-orders/${wo.body.id}/complete`)
      .set("Cookie", officerA)
      .send({ odometer: 40000, serviceOn: isoToday() })
      .expect(409);
    expect(res.body.message).toBe("odometer_decreased");
  });

  it("makes service events append-only at the database", async () => {
    const event = await prisma.serviceEvent.findFirstOrThrow({
      where: { tenantId: tenantA, vehicleId: vehicleA },
    });
    await expect(
      prisma.serviceEvent.update({ where: { id: event.id }, data: { odometer: 1 } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.serviceEvent.delete({ where: { id: event.id } })).rejects.toThrow(
      /append-only/,
    );
  });

  it("cancels an open work order and blocks approving it afterwards", async () => {
    const wo = await request(server)
      .post(`${base()}/work-orders`)
      .set("Cookie", officerA)
      .send({ vehicleId: vehicleA, title: "Tyre rotation" })
      .expect(201);
    woForCancel = wo.body.id;
    const cancelled = await request(server)
      .post(`${base()}/work-orders/${woForCancel}/cancel`)
      .set("Cookie", officerA)
      .expect(201);
    expect(cancelled.body.status).toBe("cancelled");
    const again = await request(server)
      .post(`${base()}/work-orders/${woForCancel}/approve`)
      .set("Cookie", ownerA)
      .expect(409);
    expect(again.body.message).toBe("invalid_transition");
  });

  it("lets a driver report a critical defect, which blocks dispatch", async () => {
    const res = await request(server)
      .post(`${base()}/defects`)
      .set("Cookie", driverA)
      .send({ vehicleId: vehicleA, severity: "critical", description: "Brake warning light on" })
      .expect(201);
    criticalDefect = res.body.id;
    expect(res.body.status).toBe("open");

    const status = await request(server)
      .get(`${base()}/dispatch-status?vehicleId=${vehicleA}`)
      .set("Cookie", fleetA)
      .expect(200);
    expect(status.body).toEqual({ vehicleId: vehicleA, blocked: true, criticalDefects: 1 });

    await expect(
      app.get(MaintenanceService).assertDispatchAllowed(tenantA, vehicleA),
    ).rejects.toThrow(/dispatch_blocked/);
  });

  it("denies a driver clearance and requires a real note from the maintenance officer", async () => {
    await request(server)
      .post(`${base()}/defects/${criticalDefect}/clear`)
      .set("Cookie", driverA)
      .send({ clearanceNote: "Fixed the brake sensor" })
      .expect(403);

    await request(server)
      .post(`${base()}/defects/${criticalDefect}/clear`)
      .set("Cookie", officerA)
      .send({ clearanceNote: "ok" })
      .expect(400);
  });

  it("clears the defect with a note, unblocks dispatch, and blocks a second clearance", async () => {
    const res = await request(server)
      .post(`${base()}/defects/${criticalDefect}/clear`)
      .set("Cookie", officerA)
      .send({ clearanceNote: "Replaced brake sensor and tested" })
      .expect(201);
    expect(res.body.status).toBe("cleared");

    const status = await request(server)
      .get(`${base()}/dispatch-status?vehicleId=${vehicleA}`)
      .set("Cookie", fleetA)
      .expect(200);
    expect(status.body.blocked).toBe(false);

    const again = await request(server)
      .post(`${base()}/defects/${criticalDefect}/clear`)
      .set("Cookie", officerA)
      .send({ clearanceNote: "Clearing again for no reason" })
      .expect(409);
    expect(again.body.message).toBe("defect_not_open");
  });

  it("enforces the clearance note in the database", async () => {
    await expect(
      prisma.defect.create({
        data: {
          tenantId: tenantA,
          vehicleId: vehicleA,
          severity: "minor",
          description: "x",
          status: "cleared",
          clearedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("hides another tenant's plans, work orders and vehicles", async () => {
    await request(server).get(`${base()}/plans`).set("Cookie", ownerB).expect(404);
    const cross = await request(server)
      .post(`/api/v1/tenants/${tenantB}/maintenance/work-orders`)
      .set("Cookie", ownerB)
      .send({ vehicleId: vehicleA, title: "Cross tenant job" })
      .expect(404);
    expect(cross.body.message).toBe("vehicle_not_found");
    await request(server)
      .post(`/api/v1/tenants/${tenantB}/maintenance/work-orders/${woForCancel}/approve`)
      .set("Cookie", ownerB)
      .expect(404);
  });

  it("refuses a driver the plan and work-order lists", async () => {
    await request(server).get(`${base()}/work-orders`).set("Cookie", driverA).expect(403);
    await request(server).get(`${base()}/plans`).set("Cookie", driverA).expect(403);
  });

  it("requires a session", async () => {
    await request(server).get(`${base()}/plans`).expect(401);
  });
});
