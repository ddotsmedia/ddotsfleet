import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type RoleCode } from "../src/generated/prisma/client.js";
import { AppModule } from "../src/app.module.js";
import { DocumentsService } from "../src/documents/documents.service.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for document tests");
process.env.DOCUMENT_STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "fleetos-docs-"));

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const suffix = Math.random().toString(36).slice(2, 10);
const PASSWORD = "correct horse battery";
const email = (tag: string) => `${tag}-${suffix}@test.local`;

const PDF = Buffer.from("%PDF-1.4\n% test document body\n");
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
]);
const isoDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

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

const upload = (tenantId: string, cookie: string, body: Record<string, unknown>) =>
  request(server).post(`/api/v1/tenants/${tenantId}/documents`).set("Cookie", cookie).send(body);

describe("documents, renewals and reminders", () => {
  let tenantA: string;
  let tenantB: string;
  let ownerA: string;
  let ownerB: string;
  let fleetA: string;
  let driverA: string;
  let vehicleA: string;
  let docV1: string;

  const base = () => `/api/v1/tenants/${tenantA}`;
  const pdfBody = (expiresOn: string, extra: Record<string, unknown> = {}) => ({
    subjectType: "vehicle",
    subjectId: vehicleA,
    docType: "vehicle_insurance",
    expiresOn,
    fileName: "policy.pdf",
    contentType: "application/pdf",
    contentBase64: PDF.toString("base64"),
    ...extra,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
    server = app.getHttpServer();

    ownerA = await sessionFor("doc-owner-a");
    ownerB = await sessionFor("doc-owner-b");
    tenantA = await createTenant(ownerA, `doc-a-${suffix}`);
    tenantB = await createTenant(ownerB, `doc-b-${suffix}`);
    fleetA = await sessionFor("doc-fleet-a");
    await addMember(tenantA, "doc-fleet-a", "fleet_manager");
    driverA = await sessionFor("doc-driver-a");
    await addMember(tenantA, "doc-driver-a", "driver");
    vehicleA = await createVehicle(tenantA, ownerA, `DOC ${suffix.slice(0, 4)} A`);
  });

  afterAll(async () => {
    // Audit events are append-only by design, so their tenants are left in place. Suffixes keep runs isolated.
    await app.close();
    await prisma.$disconnect();
  });

  it("uploads a document and never returns the storage key", async () => {
    const res = await upload(tenantA, fleetA, pdfBody(isoDays(10))).expect(201);
    docV1 = res.body.id;
    expect(res.body.version).toBe(1);
    expect(res.body.status).toBe("current");
    expect(res.body.fileObject.scanStatus).toBe("pending");
    expect(JSON.stringify(res.body)).not.toMatch(/object_?key|objectKey|\/var\//i);
  });

  it("rejects bytes that do not match the declared content type", async () => {
    const res = await upload(
      tenantA,
      fleetA,
      pdfBody(isoDays(400), {
        contentType: "application/pdf",
        contentBase64: PNG.toString("base64"),
      }),
    ).expect(400);
    expect(res.body.message).toBe("file_type_mismatch");
  });

  it("refuses to serve bytes until the scan passes", async () => {
    const res = await request(server)
      .get(`${base()}/documents/${docV1}/file`)
      .set("Cookie", fleetA)
      .expect(409);
    expect(res.body.message).toBe("file_not_scanned");
  });

  it("serves the bytes after a clean scan, with no-store and an attachment header", async () => {
    const doc = await prisma.document.findUniqueOrThrow({
      where: { id: docV1 },
      select: { fileObjectId: true },
    });
    await app.get(DocumentsService).recordScanResult(tenantA, doc.fileObjectId, "clean");

    const res = await request(server)
      .get(`${base()}/documents/${docV1}/file`)
      .set("Cookie", fleetA)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.from(res.body as Buffer).equals(PDF)).toBe(true);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="policy\.pdf"/);
  });

  it("replacing a document requires a later expiry and supersedes the old version", async () => {
    const driver = await request(server)
      .post(`${base()}/drivers`)
      .set("Cookie", fleetA)
      .send({ employeeCode: `DOC-${suffix}`, fullName: "Doc Driver" })
      .expect(201);
    const licence = {
      subjectType: "driver",
      subjectId: driver.body.id,
      docType: "driving_licence",
      fileName: "licence.pdf",
      contentType: "application/pdf",
      contentBase64: PDF.toString("base64"),
    };
    await upload(tenantA, fleetA, { ...licence, expiresOn: isoDays(10) }).expect(201);
    await upload(tenantA, fleetA, { ...licence, expiresOn: isoDays(5) }).expect(409);
    const res = await upload(tenantA, fleetA, { ...licence, expiresOn: isoDays(365) }).expect(201);
    expect(res.body.version).toBe(2);

    const list = await request(server)
      .get(`${base()}/documents?subjectType=driver&subjectId=${driver.body.id}`)
      .set("Cookie", fleetA)
      .expect(200);
    const statuses = Object.fromEntries(
      list.body.items.map((d: { version: number; status: string }) => [d.version, d.status]),
    );
    expect(statuses).toEqual({ 1: "superseded", 2: "current" });
  });

  it("enforces one current document per subject and type in the database", async () => {
    const current = await prisma.document.findFirstOrThrow({
      where: { tenantId: tenantA, subjectId: vehicleA, status: "current" },
      select: { subjectType: true, subjectId: true, docType: true, fileObjectId: true },
    });
    await expect(
      prisma.document.create({
        data: {
          tenantId: tenantA,
          subjectType: current.subjectType,
          subjectId: current.subjectId,
          docType: current.docType,
          version: 99,
          status: "current",
          fileObjectId: current.fileObjectId,
        },
      }),
    ).rejects.toThrow();
  });

  it("opens one renewal and records each reminder stage once, however often the run repeats", async () => {
    // The vehicle insurance v1 expires in 10 days: stages 30 and 14 apply, 7 and 0 do not yet.
    const first = await request(server)
      .post(`${base()}/renewals/reminders/run`)
      .set("Cookie", fleetA)
      .expect(201);
    expect(first.body).toEqual({ renewalsOpened: 1, remindersRecorded: 2 });

    const second = await request(server)
      .post(`${base()}/renewals/reminders/run`)
      .set("Cookie", fleetA)
      .expect(201);
    expect(second.body).toEqual({ renewalsOpened: 0, remindersRecorded: 0 });

    const open = await request(server)
      .get(`${base()}/renewals?status=open`)
      .set("Cookie", fleetA)
      .expect(200);
    expect(open.body.items).toHaveLength(1);
    expect(open.body.items[0].documentId).toBe(docV1);
  });

  it("completes the open renewal when the replacement is uploaded and does not reopen it", async () => {
    await upload(tenantA, fleetA, pdfBody(isoDays(365))).expect(201);

    const renewal = await prisma.renewal.findFirstOrThrow({
      where: { tenantId: tenantA, documentId: docV1 },
    });
    expect(renewal.status).toBe("completed");
    expect(renewal.completedAt).not.toBeNull();

    const rerun = await request(server)
      .post(`${base()}/renewals/reminders/run`)
      .set("Cookie", fleetA)
      .expect(201);
    expect(rerun.body).toEqual({ renewalsOpened: 0, remindersRecorded: 0 });
  });

  it("blocks a driver-role member from listing and uploading documents", async () => {
    await request(server).get(`${base()}/documents`).set("Cookie", driverA).expect(403);
    await upload(tenantA, driverA, pdfBody(isoDays(400))).expect(403);
  });

  it("hides another tenant's documents and subjects", async () => {
    const foreignVehicle = await createVehicle(tenantB, ownerB, `FOR ${suffix.slice(0, 4)} X`);
    const cross = await request(server)
      .post(`/api/v1/tenants/${tenantB}/documents`)
      .set("Cookie", ownerB)
      .send(pdfBody(isoDays(400), { subjectId: vehicleA }))
      .expect(404);
    expect(cross.body.message).toBe("subject_not_found");

    await request(server)
      .get(`/api/v1/tenants/${tenantB}/documents/${docV1}/file`)
      .set("Cookie", ownerB)
      .expect(404);
    await request(server)
      .get(`${base()}/documents/${docV1}/file`)
      .set("Cookie", ownerB)
      .expect(404);
    expect(foreignVehicle).toBeDefined();
  });

  it("writes an upload audit event without the storage key", async () => {
    const events = await prisma.auditEvent.findMany({
      where: { tenantId: tenantA, entityType: "document", action: "upload" },
    });
    expect(events.length).toBe(4);
    expect(JSON.stringify(events.map((e) => e.changes))).not.toMatch(/object_key|objectKey/);
  });

  it("requires a session", async () => {
    await request(server).get(`${base()}/documents`).expect(401);
  });
});
