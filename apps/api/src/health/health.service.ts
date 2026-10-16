import { Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";

export interface HealthReport {
  status: "ok" | "degraded";
  service: string;
  version: string;
  checks: { database: "ok" | "error" | "skipped"; redis: "skipped" };
  timestamp: string;
}

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  async ready(): Promise<HealthReport> {
    let database: "ok" | "error" = "ok";
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = "error";
    }
    return {
      status: database === "ok" ? "ok" : "degraded",
      service: "fleetos-api",
      version: process.env.APP_VERSION ?? "0.1.0",
      checks: { database, redis: "skipped" },
      timestamp: new Date().toISOString(),
    };
  }
}
