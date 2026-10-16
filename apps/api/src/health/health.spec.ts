import { Test } from "@nestjs/testing";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../app.module.js";

describe("health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix("api/v1", { exclude: ["health/live", "health/ready"] });
    await app.init();
  });

  afterAll(async () => app.close());

  it("GET /health/live returns ok", async () => {
    await request(app.getHttpServer()).get("/health/live").expect(200, { status: "ok" });
  });

  it("GET /health/ready reports service", async () => {
    const res = await request(app.getHttpServer()).get("/health/ready").expect(200);
    expect(res.body.service).toBe("fleetos-api");
    expect(res.body.status).toBe("ok");
  });
});
