import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { AppModule } from "../src/app.module.js";
import { MAIL_TRANSPORT, type MailMessage, type MailTransport } from "../src/common/mail.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for auth tests");
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const suffix = Math.random().toString(36).slice(2, 10);
const PASSWORD = "correct horse battery";

class CapturingMail implements MailTransport {
  messages: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.messages.push(message);
  }
  tokenFor(to: string): string {
    const msg = [...this.messages].reverse().find((m) => m.to === to);
    const match = msg?.text.match(/token=([A-Za-z0-9_-]+)/);
    if (!match) throw new Error(`no invitation token mailed to ${to}`);
    return match[1]!;
  }
}

const mail = new CapturingMail();
let app: INestApplication;
let server: Parameters<typeof request>[0];

const email = (tag: string) => `${tag}-${suffix}@test.local`;

async function register(tag: string): Promise<string> {
  await request(server)
    .post("/api/v1/auth/register")
    .send({ email: email(tag), password: PASSWORD, displayName: tag })
    .expect(201);
  return login(tag);
}

async function login(tag: string): Promise<string> {
  const res = await request(server)
    .post("/api/v1/auth/login")
    .send({ email: email(tag), password: PASSWORD })
    .expect(200);
  const cookie = res.headers["set-cookie"]?.[0];
  expect(cookie).toMatch(/^fleetos_session=[^;]+;.*Path=\/.*HttpOnly.*SameSite=Lax/);
  return cookie!.split(";")[0]!;
}

async function createTenant(cookie: string, slug: string): Promise<string> {
  const res = await request(server)
    .post("/api/v1/tenants")
    .set("Cookie", cookie)
    .send({ name: `Tenant ${slug}`, slug })
    .expect(201);
  return res.body.id as string;
}

describe("auth, onboarding and invitations", () => {
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAIL_TRANSPORT)
      .useValue(mail)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    const tenantSlug = { endsWith: suffix };
    await prisma.invitation.deleteMany({ where: { tenant: { slug: tenantSlug } } });
    await prisma.grant.deleteMany({ where: { membership: { tenant: { slug: tenantSlug } } } });
    await prisma.tenantMembership.deleteMany({ where: { tenant: { slug: tenantSlug } } });
    await prisma.rolePermission.deleteMany({ where: { role: { tenant: { slug: tenantSlug } } } });
    await prisma.role.deleteMany({ where: { tenant: { slug: tenantSlug } } });
    await prisma.tenant.deleteMany({ where: { slug: tenantSlug } });
    await prisma.session.deleteMany({
      where: { user: { email: { endsWith: `${suffix}@test.local` } } },
    });
    await prisma.user.deleteMany({ where: { email: { endsWith: `${suffix}@test.local` } } });
    await prisma.$disconnect();
    await app.close();
  });

  it("registers, logs in, reads the profile and logs out, revoking the session", async () => {
    const cookie = await register("reg");
    const me = await request(server).get("/api/v1/auth/me").set("Cookie", cookie).expect(200);
    expect(me.body.email).toBe(email("reg"));
    expect(me.body).not.toHaveProperty("passwordHash");
    await request(server).post("/api/v1/auth/logout").set("Cookie", cookie).expect(200);
    await request(server).get("/api/v1/auth/me").set("Cookie", cookie).expect(401);
  });

  it("stores only a hash of the session token", async () => {
    const cookie = await register("hash");
    const token = cookie.split("=")[1]!;
    const stored = await prisma.session.findMany({ where: { user: { email: email("hash") } } });
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((s) => s.tokenHash !== token && s.tokenHash.length === 64)).toBe(true);
  });

  it("answers unknown users and wrong passwords identically", async () => {
    await register("pw");
    await request(server)
      .post("/api/v1/auth/login")
      .send({ email: email("pw"), password: "wrong-password-value" })
      .expect(401);
    await request(server)
      .post("/api/v1/auth/login")
      .send({ email: email("nobody"), password: PASSWORD })
      .expect(401);
  });

  it("locks login for an email after 10 failures in the window", async () => {
    await register("lock");
    for (let i = 0; i < 10; i++) {
      await request(server)
        .post("/api/v1/auth/login")
        .send({ email: email("lock"), password: "wrong-password-value" })
        .expect(401);
    }
    await request(server)
      .post("/api/v1/auth/login")
      .send({ email: email("lock"), password: PASSWORD })
      .expect(429);
  });

  it("rejects duplicate registration and weak passwords", async () => {
    await register("dupe");
    await request(server)
      .post("/api/v1/auth/register")
      .send({ email: email("dupe"), password: PASSWORD, displayName: "Dupe User" })
      .expect(409);
    await request(server)
      .post("/api/v1/auth/register")
      .send({ email: email("weak"), password: "short", displayName: "x" })
      .expect(400);
  });

  it("requires a session to create a tenant", async () => {
    await request(server)
      .post("/api/v1/tenants")
      .send({ name: "No Session", slug: `nosess-${suffix}` })
      .expect(401);
  });

  it("creates a tenant with eight roles and makes the caller an active company admin", async () => {
    const cookie = await register("owner");
    const slug = `acme-${suffix}`;
    const tenantId = await createTenant(cookie, slug);

    const roles = await prisma.role.findMany({ where: { tenantId } });
    expect(roles).toHaveLength(8);
    const membership = await prisma.tenantMembership.findUniqueOrThrow({
      where: {
        tenantId_userId: {
          tenantId,
          userId: (await prisma.user.findUniqueOrThrow({ where: { email: email("owner") } })).id,
        },
      },
      include: { grants: { include: { role: true } } },
    });
    expect(membership.status).toBe("active");
    expect(membership.grants.map((g) => g.role.roleCode)).toEqual(["company_admin"]);
  });

  it("rejects duplicate slugs and malformed slugs", async () => {
    const cookie = await register("slugs");
    await createTenant(cookie, `beta-${suffix}`);
    await request(server)
      .post("/api/v1/tenants")
      .set("Cookie", cookie)
      .send({ name: "Dup", slug: `beta-${suffix}` })
      .expect(409);
    await request(server)
      .post("/api/v1/tenants")
      .set("Cookie", cookie)
      .send({ name: "Bad", slug: "Bad Slug" })
      .expect(400);
  });

  it("lets only active company admins invite, and never returns the invitation token", async () => {
    const adminCookie = await register("inv-admin");
    const tenantId = await createTenant(adminCookie, `gamma-${suffix}`);

    const res = await request(server)
      .post(`/api/v1/tenants/${tenantId}/invitations`)
      .set("Cookie", adminCookie)
      .send({ email: email("inv-mgr"), roleCode: "fleet_manager" })
      .expect(201);
    expect(res.body).not.toHaveProperty("token");
    expect(res.body).not.toHaveProperty("tokenHash");
    expect(mail.messages.at(-1)?.to).toBe(email("inv-mgr"));

    const stored = await prisma.invitation.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.tokenHash).not.toBe(mail.tokenFor(email("inv-mgr")));

    // Non-member and non-admin callers are refused.
    const outsiderCookie = await register("outsider");
    await request(server)
      .post(`/api/v1/tenants/${tenantId}/invitations`)
      .set("Cookie", outsiderCookie)
      .send({ email: email("x-1"), roleCode: "driver" })
      .expect(404);

    const mgrCookie = await register("inv-mgr");
    await request(server)
      .post("/api/v1/auth/invitations/accept")
      .set("Cookie", mgrCookie)
      .send({ token: mail.tokenFor(email("inv-mgr")) })
      .expect(200);
    await request(server)
      .post(`/api/v1/tenants/${tenantId}/invitations`)
      .set("Cookie", mgrCookie)
      .send({ email: email("x-2"), roleCode: "driver" })
      .expect(403);
  });

  it("accepts an invitation once, only for the invited email, and creates the grant", async () => {
    const adminCookie = await register("acc-admin");
    const tenantId = await createTenant(adminCookie, `delta-${suffix}`);
    await request(server)
      .post(`/api/v1/tenants/${tenantId}/invitations`)
      .set("Cookie", adminCookie)
      .send({ email: email("acc-disp"), roleCode: "dispatcher" })
      .expect(201);
    const token = mail.tokenFor(email("acc-disp"));

    const wrongCookie = await register("acc-wrong");
    await request(server)
      .post("/api/v1/auth/invitations/accept")
      .set("Cookie", wrongCookie)
      .send({ token })
      .expect(403);

    const dispCookie = await register("acc-disp");
    const accepted = await request(server)
      .post("/api/v1/auth/invitations/accept")
      .set("Cookie", dispCookie)
      .send({ token })
      .expect(200);
    expect(accepted.body).toEqual({ tenantId, roleCode: "dispatcher", membershipStatus: "active" });

    await request(server)
      .post("/api/v1/auth/invitations/accept")
      .set("Cookie", dispCookie)
      .send({ token })
      .expect(409);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: email("acc-disp") } });
    const membership = await prisma.tenantMembership.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId, userId: user.id } },
      include: { grants: { include: { role: true } } },
    });
    expect(membership.status).toBe("active");
    expect(membership.grants.map((g) => g.role.roleCode)).toEqual(["dispatcher"]);
  });

  it("returns 404 for unknown tokens and 410 for expired ones", async () => {
    const adminCookie = await register("exp-admin");
    const tenantId = await createTenant(adminCookie, `eps-${suffix}`);
    const memberCookie = await register("exp-user");

    await request(server)
      .post("/api/v1/auth/invitations/accept")
      .set("Cookie", memberCookie)
      .send({ token: "unknown-token-value-0000000000" })
      .expect(404);

    await request(server)
      .post(`/api/v1/tenants/${tenantId}/invitations`)
      .set("Cookie", adminCookie)
      .send({ email: email("exp-user"), roleCode: "driver" })
      .expect(201);
    const token = mail.tokenFor(email("exp-user"));
    await prisma.invitation.updateMany({
      where: { tenantId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await request(server)
      .post("/api/v1/auth/invitations/accept")
      .set("Cookie", memberCookie)
      .send({ token })
      .expect(410);
  });

  it("validates tenant ids and invitation payloads", async () => {
    const cookie = await register("validate");
    const tenantId = await createTenant(cookie, `zeta-${suffix}`);
    await request(server)
      .post("/api/v1/tenants/not-a-uuid/invitations")
      .set("Cookie", cookie)
      .send({ email: email("v-1"), roleCode: "driver" })
      .expect(400);
    await request(server)
      .post(`/api/v1/tenants/${tenantId}/invitations`)
      .set("Cookie", cookie)
      .send({ email: email("v-1"), roleCode: "superuser" })
      .expect(400);
  });
});
