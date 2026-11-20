import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type RoleCode } from "../src/generated/prisma/client.js";
import { AppModule } from "../src/app.module.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for dispatch tests");
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

async function addMember(tenantId: string, tag: string, roleCode: RoleCode): Promise<string> {
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

describe("trips, dispatch jobs and daily reviews", () => {
  let tenantA: string;
  let ownerA: string;
  let ownerB: string;
  let driverCookie: string;
  let dispatcherCookie: string;
  let supervisorCookie: string;
  let fleetCookie: string;
  let driverLinked: string;
  let driverUnlinked: string;
  let vehicle1: string;
  let vehicle2: string;
  let vehicle3: string;
  let vehicle4: string;
  let vehicleNoCheckout: string;
  let jobAssigned: string;
  let jobOpen: string;
  let trip1: string;
  let trip1Date: string;
  let review1: string;
  let review2: string;
  const base = () => `/api/v1/tenants/${tenantA}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
    server = app.getHttpServer();

    ownerA = await sessionFor("dsp-owner-a");
    ownerB = await sessionFor("dsp-owner-b");
    tenantA = await createTenant(ownerA, `dsp-a-${suffix}`);
    await createTenant(ownerB, `dsp-b-${suffix}`);

    driverCookie = await sessionFor("dsp-driver-a");
    const driverUserId = await addMember(tenantA, "dsp-driver-a", "driver");
    dispatcherCookie = await sessionFor("dsp-dispatcher-a");
    await addMember(tenantA, "dsp-dispatcher-a", "dispatcher");
    supervisorCookie = await sessionFor("dsp-supervisor-a");
    await addMember(tenantA, "dsp-supervisor-a", "supervisor");
    fleetCookie = await sessionFor("dsp-fleet-a");
    await addMember(tenantA, "dsp-fleet-a", "fleet_manager");

    driverLinked = await createDriver(tenantA, ownerA, `DSP-${suffix}-1`);
    driverUnlinked = await createDriver(tenantA, ownerA, `DSP-${suffix}-2`);
    await request(server)
      .patch(`${base()}/drivers/${driverLinked}`)
      .set("Cookie", ownerA)
      .send({ linkedUserId: driverUserId })
      .expect(200);

    vehicle1 = await createVehicle(tenantA, ownerA, `DSP ${suffix.slice(0, 4)} 1`);
    vehicle2 = await createVehicle(tenantA, ownerA, `DSP ${suffix.slice(0, 4)} 2`);
    vehicle3 = await createVehicle(tenantA, ownerA, `DSP ${suffix.slice(0, 4)} 3`);
    vehicle4 = await createVehicle(tenantA, ownerA, `DSP ${suffix.slice(0, 4)} 4`);
    vehicleNoCheckout = vehicle3;
  });

  afterAll(async () => {
    // Audit and append-only history are kept by design. Suffixes keep runs isolated.
    await app.close();
    await prisma.$disconnect();
  });

  it("creates a job and assigns it to a vehicle and an active driver", async () => {
    const job = await request(server)
      .post(`${base()}/dispatch/jobs`)
      .set("Cookie", dispatcherCookie)
      .send({ reference: `JOB-${suffix}-A`, customerName: "Acme Logistics", priority: "high" })
      .expect(201);
    jobAssigned = job.body.id;
    expect(job.body.status).toBe("planned");

    await request(server)
      .post(`${base()}/dispatch/jobs`)
      .set("Cookie", dispatcherCookie)
      .send({ reference: `JOB-${suffix}-A`, customerName: "Duplicate" })
      .expect(409);

    const assigned = await request(server)
      .post(`${base()}/dispatch/jobs/${jobAssigned}/assign`)
      .set("Cookie", dispatcherCookie)
      .send({ vehicleId: vehicle1, driverId: driverLinked })
      .expect(201);
    expect(assigned.body.status).toBe("assigned");

    const open = await request(server)
      .post(`${base()}/dispatch/jobs`)
      .set("Cookie", dispatcherCookie)
      .send({ reference: `JOB-${suffix}-B`, customerName: "Unassigned" })
      .expect(201);
    jobOpen = open.body.id;
  });

  it("requires an open checkout by the same driver before a trip can start", async () => {
    await request(server)
      .post(`${base()}/trips`)
      .set("Cookie", driverCookie)
      .send({
        vehicleId: vehicleNoCheckout,
        driverId: driverLinked,
        purpose: "Delivery",
        originDeclared: "Depot",
        destinationDeclared: "Customer",
        startOdometer: 10_000,
      })
      .expect(409);

    await request(server)
      .post(`${base()}/checkouts`)
      .set("Cookie", driverCookie)
      .send({
        vehicleId: vehicle1,
        driverId: driverLinked,
        openingOdometer: 10_000,
        openingFuelPercent: 90,
      })
      .expect(201);
  });

  it("starts a trip against a job, rejects a second open trip, and refuses a decreasing odometer", async () => {
    const trip = await request(server)
      .post(`${base()}/trips`)
      .set("Cookie", driverCookie)
      .send({
        vehicleId: vehicle1,
        driverId: driverLinked,
        jobId: jobAssigned,
        purpose: "Delivery",
        originDeclared: "Depot",
        destinationDeclared: "Customer site",
        startOdometer: 10_050,
        clientRef: `trip-${suffix}`,
      })
      .expect(201);
    trip1 = trip.body.id;
    trip1Date = trip.body.operationDate.slice(0, 10);
    expect(trip.body.status).toBe("open");

    await request(server)
      .post(`${base()}/trips`)
      .set("Cookie", driverCookie)
      .send({
        vehicleId: vehicle1,
        driverId: driverLinked,
        purpose: "Second",
        originDeclared: "A",
        destinationDeclared: "B",
        startOdometer: 10_060,
      })
      .expect(409);
  });

  it("records declared stops in order and completes the trip with a non-decreasing odometer", async () => {
    const stop = await request(server)
      .post(`${base()}/trips/${trip1}/stops`)
      .set("Cookie", driverCookie)
      .send({ eventType: "arrived", odometer: 10_060, clientRef: `stop-${suffix}` })
      .expect(201);
    expect(stop.body.stopOrder).toBe(1);

    const retry = await request(server)
      .post(`${base()}/trips/${trip1}/stops`)
      .set("Cookie", driverCookie)
      .send({ eventType: "arrived", odometer: 10_060, clientRef: `stop-${suffix}` })
      .expect(201);
    expect(retry.body.id).toBe(stop.body.id);

    await request(server)
      .post(`${base()}/trips/${trip1}/stops`)
      .set("Cookie", driverCookie)
      .send({ eventType: "note" })
      .expect(400);
    await request(server)
      .post(`${base()}/trips/${trip1}/stops`)
      .set("Cookie", driverCookie)
      .send({ eventType: "departed", odometer: 10_000 })
      .expect(409);

    await request(server)
      .post(`${base()}/trips/${trip1}/complete`)
      .set("Cookie", driverCookie)
      .send({ endOdometer: 10_040 })
      .expect(409);

    const done = await request(server)
      .post(`${base()}/trips/${trip1}/complete`)
      .set("Cookie", driverCookie)
      .send({ endOdometer: 10_100, clientRef: "end-trip1" })
      .expect(201);
    expect(done.body.status).toBe("completed");

    // Offline retry with the same clientRef returns the closed trip instead of 409.
    const replay = await request(server)
      .post(`${base()}/trips/${trip1}/complete`)
      .set("Cookie", driverCookie)
      .send({ endOdometer: 10_100, clientRef: "end-trip1" })
      .expect(201);
    expect(replay.body.id).toBe(trip1);
    expect(replay.body.endOdometer).toBe(10_100);

    await request(server)
      .post(`${base()}/trips/${trip1}/stops`)
      .set("Cookie", driverCookie)
      .send({ eventType: "note", note: "After close" })
      .expect(409);

    const detail = await request(server)
      .get(`${base()}/trips/${trip1}`)
      .set("Cookie", ownerA)
      .expect(200);
    expect(detail.body.stops).toHaveLength(1);
  });

  it("limits drivers to jobs assigned to them and enforces job transitions", async () => {
    await request(server)
      .post(`${base()}/dispatch/jobs/${jobOpen}/events`)
      .set("Cookie", driverCookie)
      .send({ eventType: "cancelled" })
      .expect(403);

    await request(server)
      .post(`${base()}/dispatch/jobs/${jobAssigned}/events`)
      .set("Cookie", driverCookie)
      .send({ eventType: "arrived" })
      .expect(409);

    const key = `jev-${suffix}`;
    const started = await request(server)
      .post(`${base()}/dispatch/jobs/${jobAssigned}/events`)
      .set("Cookie", driverCookie)
      .send({ eventType: "started", clientRef: key })
      .expect(201);
    const replay = await request(server)
      .post(`${base()}/dispatch/jobs/${jobAssigned}/events`)
      .set("Cookie", driverCookie)
      .send({ eventType: "started", clientRef: key })
      .expect(201);
    expect(replay.body.id).toBe(started.body.id);

    await request(server)
      .post(`${base()}/dispatch/jobs/${jobAssigned}/events`)
      .set("Cookie", driverCookie)
      .send({ eventType: "started" })
      .expect(409);

    await request(server)
      .post(`${base()}/dispatch/jobs/${jobAssigned}/events`)
      .set("Cookie", driverCookie)
      .send({ eventType: "delivered", note: "Signed by receiver" })
      .expect(201);
    const completed = await request(server)
      .post(`${base()}/dispatch/jobs/${jobAssigned}/events`)
      .set("Cookie", driverCookie)
      .send({ eventType: "completed" })
      .expect(201);
    expect(completed.body.eventType).toBe("completed");

    const jobs = await request(server)
      .get(`${base()}/dispatch/jobs`)
      .set("Cookie", ownerA)
      .expect(200);
    const job = jobs.body.items.find((j: { id: string }) => j.id === jobAssigned);
    expect(job.status).toBe("completed");
  });

  it("requires a supervisor review, supports correction, and closes the day", async () => {
    const opened = await request(server)
      .post(`${base()}/reviews`)
      .set("Cookie", driverCookie)
      .send({ vehicleId: vehicle1, operationDate: trip1Date })
      .expect(201);
    review1 = opened.body.id;
    expect(opened.body.state).toBe("draft");

    const again = await request(server)
      .post(`${base()}/reviews`)
      .set("Cookie", driverCookie)
      .send({ vehicleId: vehicle1, operationDate: trip1Date })
      .expect(201);
    expect(again.body.id).toBe(review1);

    await request(server)
      .post(`${base()}/reviews/${review1}/approve`)
      .set("Cookie", supervisorCookie)
      .send({})
      .expect(409);

    const submitted = await request(server)
      .post(`${base()}/reviews/${review1}/submit`)
      .set("Cookie", driverCookie)
      .send({})
      .expect(201);
    expect(submitted.body.state).toBe("submitted");

    await request(server)
      .post(`${base()}/reviews/${review1}/request-correction`)
      .set("Cookie", supervisorCookie)
      .send({ note: "short" })
      .expect(400);
    const corrected = await request(server)
      .post(`${base()}/reviews/${review1}/request-correction`)
      .set("Cookie", supervisorCookie)
      .send({ note: "Mileage on stop 1 does not match the log" })
      .expect(201);
    expect(corrected.body.state).toBe("correction_requested");

    await request(server)
      .post(`${base()}/reviews/${review1}/submit`)
      .set("Cookie", driverCookie)
      .send({ note: "Corrected mileage" })
      .expect(201);
    const approved = await request(server)
      .post(`${base()}/reviews/${review1}/approve`)
      .set("Cookie", supervisorCookie)
      .send({})
      .expect(201);
    expect(approved.body.state).toBe("approved");
    const closed = await request(server)
      .post(`${base()}/reviews/${review1}/close`)
      .set("Cookie", supervisorCookie)
      .send({})
      .expect(201);
    expect(closed.body.state).toBe("closed");

    await request(server)
      .post(`${base()}/reviews/${review1}/close`)
      .set("Cookie", supervisorCookie)
      .send({})
      .expect(409);
  });

  it("blocks a review submission while a trip is still open, and forbids self-approval", async () => {
    // Driver returns vehicle 1, then takes vehicle 2 on the same operation day.
    const co1 = await request(server)
      .get(`${base()}/checkouts?vehicleId=${vehicle1}&status=open`)
      .set("Cookie", ownerA)
      .expect(200);
    await request(server)
      .post(`${base()}/checkouts/${co1.body.items[0].id}/return`)
      .set("Cookie", driverCookie)
      .send({ closingOdometer: 10_100, closingFuelPercent: 40 })
      .expect(201);

    await request(server)
      .post(`${base()}/checkouts`)
      .set("Cookie", driverCookie)
      .send({
        vehicleId: vehicle2,
        driverId: driverLinked,
        openingOdometer: 500,
        openingFuelPercent: 80,
      })
      .expect(201);
    const trip2 = await request(server)
      .post(`${base()}/trips`)
      .set("Cookie", driverCookie)
      .send({
        vehicleId: vehicle2,
        driverId: driverLinked,
        purpose: "Pickup",
        originDeclared: "Depot",
        destinationDeclared: "Port",
        startOdometer: 500,
      })
      .expect(201);

    const rev2 = await request(server)
      .post(`${base()}/reviews`)
      .set("Cookie", ownerA)
      .send({ vehicleId: vehicle2, operationDate: trip2.body.operationDate.slice(0, 10) })
      .expect(201);
    review2 = rev2.body.id;

    await request(server)
      .post(`${base()}/reviews/${review2}/submit`)
      .set("Cookie", driverCookie)
      .send({})
      .expect(409);

    await request(server)
      .post(`${base()}/trips/${trip2.body.id}/complete`)
      .set("Cookie", driverCookie)
      .send({ endOdometer: 520 })
      .expect(201);

    // Admin submitted this review, so admin cannot approve it.
    await request(server)
      .post(`${base()}/reviews/${review2}/submit`)
      .set("Cookie", ownerA)
      .send({})
      .expect(201);
    await request(server)
      .post(`${base()}/reviews/${review2}/approve`)
      .set("Cookie", ownerA)
      .send({})
      .expect(403);
  });

  it("refuses a trip where a critical defect blocks dispatch", async () => {
    await request(server)
      .post(`${base()}/inspections`)
      .set("Cookie", ownerA)
      .send({
        vehicleId: vehicle4,
        kind: "pre_trip",
        items: [{ code: "brakes", label: "Brakes", answer: "fail", severity: "critical" }],
      })
      .expect(201);

    await request(server)
      .post(`${base()}/trips`)
      .set("Cookie", ownerA)
      .send({
        vehicleId: vehicle4,
        driverId: driverUnlinked,
        purpose: "Blocked",
        originDeclared: "A",
        destinationDeclared: "B",
        startOdometer: 1,
      })
      .expect(409);
  });

  it("enforces role permissions on trips, jobs and reviews", async () => {
    await request(server)
      .post(`${base()}/trips`)
      .set("Cookie", fleetCookie)
      .send({
        vehicleId: vehicle2,
        driverId: driverLinked,
        purpose: "x",
        originDeclared: "x",
        destinationDeclared: "y",
        startOdometer: 1,
      })
      .expect(403);
    await request(server)
      .post(`${base()}/dispatch/jobs`)
      .set("Cookie", driverCookie)
      .send({ reference: `JOB-${suffix}-Z`, customerName: "Nope" })
      .expect(403);
    await request(server)
      .post(`${base()}/reviews/${review2}/close`)
      .set("Cookie", dispatcherCookie)
      .send({})
      .expect(403);
    await request(server).get(`${base()}/trips`).set("Cookie", driverCookie).expect(200);
    const access = await request(server)
      .get(`${base()}/access`)
      .set("Cookie", driverCookie)
      .expect(200);
    expect(access.body.linkedDriverId).toBe(driverLinked);
    const adminAccess = await request(server)
      .get(`${base()}/access`)
      .set("Cookie", fleetCookie)
      .expect(200);
    expect(adminAccess.body.linkedDriverId).toBeNull();
  });

  it("keeps tenants isolated for trips, jobs and reviews", async () => {
    await request(server).get(`${base()}/trips`).set("Cookie", ownerB).expect(404);
    await request(server).get(`${base()}/dispatch/jobs`).set("Cookie", ownerB).expect(404);
    await request(server).get(`${base()}/reviews`).set("Cookie", ownerB).expect(404);
    await request(server)
      .post(`${base()}/dispatch/jobs/${jobOpen}/assign`)
      .set("Cookie", ownerB)
      .send({ vehicleId: vehicle1, driverId: driverLinked })
      .expect(404);
  });
});
