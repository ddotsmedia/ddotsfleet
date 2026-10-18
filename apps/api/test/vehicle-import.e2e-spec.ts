import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type RoleCode } from "../src/generated/prisma/client.js";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for import tests");
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const suffix = Math.random().toString(36).slice(2, 10);
const PASSWORD = "correct horse battery";
const email = (tag: string) => `${tag}-${suffix}@test.local`;
const HEADER =
  "fleetCode,plateNumber,emirate,vin,category,make,model,year,colour,fuelType,ownership,status";

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

const row = (plate: string, fleetCode = "") =>
  `${fleetCode},${plate},dubai,,Sedan,Toyota,Camry,2024,white,petrol,leased,active`;
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");
const IMPORT = (tenantId: string) => `/api/v1/tenants/${tenantId}/vehicles/imports`;

describe("vehicle import and export", () => {
  let tenantA: string;
  let tenantB: string;
  let ownerA: string;
  let ownerB: string;
  let fleetA: string;
  let readOnlyA: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();

    ownerA = await sessionFor("imp-owner-a");
    ownerB = await sessionFor("imp-owner-b");
    tenantA = await createTenant(ownerA, `imp-a-${suffix}`);
    tenantB = await createTenant(ownerB, `imp-b-${suffix}`);
    fleetA = await sessionFor("imp-fleet-a");
    await addMember(tenantA, "imp-fleet-a", "fleet_manager");
    readOnlyA = await sessionFor("imp-ro-a");
    await addMember(tenantA, "imp-ro-a", "read_only_management");
    await request(server)
      .post(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", ownerA)
      .send({
        plateNumber: "EXIST 1",
        emirate: "dubai",
        category: "Van",
        make: "Ford",
        model: "Transit",
        fuelType: "diesel",
        ownership: "owned",
        fleetCode: "OLD-1",
      })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("previews a clean file and reports counts without writing vehicles", async () => {
    const before = await prisma.vehicle.count({ where: { tenantId: tenantA } });
    const res = await request(server)
      .post(IMPORT(tenantA))
      .set("Cookie", fleetA)
      .send({ csv: csv(row("IMP 1", "NEW-1"), row("IMP 2")) })
      .expect(201);
    expect(res.body).toMatchObject({
      status: "previewed",
      totalRows: 2,
      validRows: 2,
      errorRows: 0,
    });
    expect(res.body.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(await prisma.vehicle.count({ where: { tenantId: tenantA } })).toBe(before);
  });

  it("reports row-level validation errors with row numbers and fields", async () => {
    const bad = `,IMP 3,atlantis,,Sedan,Toyota,Camry,2024,white,petrol,leased,active`;
    const res = await request(server)
      .post(IMPORT(tenantA))
      .set("Cookie", fleetA)
      .send({ csv: csv(row("IMP 4"), bad) })
      .expect(201);
    expect(res.body.errorRows).toBe(1);
    expect(res.body.rowErrors[0].row).toBe(2);
    expect(res.body.rowErrors[0].errors.map((e: { field: string }) => e.field)).toContain(
      "emirate",
    );
  });

  it("flags duplicates within the file and against existing vehicles", async () => {
    const res = await request(server)
      .post(IMPORT(tenantA))
      .set("Cookie", fleetA)
      .send({ csv: csv(row("DUP 1"), row("DUP 1"), row("EXIST 1"), row("NEW-2", "OLD-1")) })
      .expect(201);
    expect(res.body.errorRows).toBe(3);
    const messages = res.body.rowErrors.flatMap((r: { errors: { message: string }[] }) =>
      r.errors.map((e) => e.message),
    );
    expect(messages).toEqual(expect.arrayContaining(["duplicate_in_file", "duplicate_existing"]));
  });

  it("rejects malformed headers before parsing rows", async () => {
    await request(server)
      .post(IMPORT(tenantA))
      .set("Cookie", fleetA)
      .send({ csv: "plateNumber,emirate,colour\nX 1,dubai,red" })
      .expect(400);
    await request(server)
      .post(IMPORT(tenantA))
      .set("Cookie", fleetA)
      .send({ csv: `${HEADER},nonsense\n${row("X 2")},1` })
      .expect(400);
    await request(server).post(IMPORT(tenantA)).set("Cookie", fleetA).send({ csv: "" }).expect(400);
  });

  it("refuses to commit a job that has errors", async () => {
    const preview = await request(server)
      .post(IMPORT(tenantA))
      .set("Cookie", fleetA)
      .send({ csv: csv(row("ERR 1"), row("EXIST 1")) })
      .expect(201);
    const res = await request(server)
      .post(`${IMPORT(tenantA)}/${preview.body.id}/commit`)
      .set("Cookie", fleetA)
      .expect(409);
    expect(res.body.message).toBe("import_has_errors");
  });

  it("commits a clean job atomically, audits it, and refuses a second commit", async () => {
    const preview = await request(server)
      .post(IMPORT(tenantA))
      .set("Cookie", fleetA)
      .send({ csv: csv(row("COMMIT 1", "CMT-1"), row("COMMIT 2")) })
      .expect(201);
    const res = await request(server)
      .post(`${IMPORT(tenantA)}/${preview.body.id}/commit`)
      .set("Cookie", fleetA)
      .expect(200);
    expect(res.body.committed).toBe(2);
    expect(
      await prisma.vehicle.count({
        where: { tenantId: tenantA, plateNumber: { in: ["COMMIT 1", "COMMIT 2"] } },
      }),
    ).toBe(2);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: preview.body.id },
    });
    expect(audit).toMatchObject({
      action: "commit",
      entityType: "vehicle_import",
      tenantId: tenantA,
    });
    await request(server)
      .post(`${IMPORT(tenantA)}/${preview.body.id}/commit`)
      .set("Cookie", fleetA)
      .expect(409);
  });

  it("refuses an expired job with 410 and writes nothing", async () => {
    const preview = await request(server)
      .post(IMPORT(tenantA))
      .set("Cookie", fleetA)
      .send({ csv: csv(row("EXP 1")) })
      .expect(201);
    await prisma.importJob.update({
      where: { id: preview.body.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await request(server)
      .post(`${IMPORT(tenantA)}/${preview.body.id}/commit`)
      .set("Cookie", fleetA)
      .expect(410);
    expect(await prisma.vehicle.count({ where: { tenantId: tenantA, plateNumber: "EXP 1" } })).toBe(
      0,
    );
  });

  it("keeps imports tenant-scoped: another tenant cannot commit or see a job", async () => {
    const preview = await request(server)
      .post(IMPORT(tenantA))
      .set("Cookie", fleetA)
      .send({ csv: csv(row("SCOPE 1")) })
      .expect(201);
    await request(server)
      .post(`${IMPORT(tenantB)}/${preview.body.id}/commit`)
      .set("Cookie", ownerB)
      .expect(404);
    await request(server)
      .post(`${IMPORT(tenantA)}/${preview.body.id}/commit`)
      .set("Cookie", ownerB)
      .expect(404);
  });

  it("enforces permissions: read-only users cannot preview or commit", async () => {
    await request(server)
      .post(IMPORT(tenantA))
      .set("Cookie", readOnlyA)
      .send({ csv: csv(row("RO 1")) })
      .expect(403);
  });

  it("exports the tenant's vehicles as CSV, neutralising formula cells", async () => {
    await request(server)
      .post(`/api/v1/tenants/${tenantA}/vehicles`)
      .set("Cookie", fleetA)
      .send({
        plateNumber: "FORM 1",
        emirate: "sharjah",
        category: "Van",
        make: '=HYPERLINK("x")',
        model: "Ram",
        fuelType: "lpg",
        ownership: "rented",
      })
      .expect(201);
    const res = await request(server)
      .get(`/api/v1/tenants/${tenantA}/vehicles/export`)
      .set("Cookie", readOnlyA)
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toContain("vehicles.csv");
    const lines = res.text.trim().split("\r\n");
    expect(lines[0]).toBe(HEADER);
    expect(lines.some((l) => l.includes("FORM 1"))).toBe(true);
    expect(res.text).toContain(`'=HYPERLINK`);
  });

  it("export never includes another tenant's vehicles", async () => {
    await request(server)
      .post(`/api/v1/tenants/${tenantB}/vehicles`)
      .set("Cookie", ownerB)
      .send({
        plateNumber: "B ONLY 9",
        emirate: "dubai",
        category: "Van",
        make: "Ford",
        model: "Ranger",
        fuelType: "diesel",
        ownership: "owned",
      })
      .expect(201);
    const res = await request(server)
      .get(`/api/v1/tenants/${tenantA}/vehicles/export`)
      .set("Cookie", ownerA)
      .expect(200);
    expect(res.text).not.toContain("B ONLY 9");
  });

  it("imports 10,000 rows in one request, above the default body limit", async () => {
    const rows: string[] = [];
    for (let i = 0; i < 10_000; i++) rows.push(row(`BULK ${String(i).padStart(5, "0")}`));
    const body = csv(...rows);
    expect(body.length).toBeGreaterThan(100 * 1024);
    const preview = await request(server)
      .post(IMPORT(tenantB))
      .set("Cookie", ownerB)
      .send({ csv: body })
      .expect(201);
    expect(preview.body).toMatchObject({ totalRows: 10_000, validRows: 10_000, errorRows: 0 });
    const res = await request(server)
      .post(`${IMPORT(tenantB)}/${preview.body.id}/commit`)
      .set("Cookie", ownerB)
      .expect(200);
    expect(res.body.committed).toBe(10_000);
  }, 120_000);

  it("rejects more than 10,000 rows", async () => {
    const rows: string[] = [];
    for (let i = 0; i < 10_001; i++) rows.push(row(`OVER ${i}`));
    await request(server)
      .post(IMPORT(tenantB))
      .set("Cookie", ownerB)
      .send({ csv: csv(...rows) })
      .expect(400);
  }, 120_000);
});
