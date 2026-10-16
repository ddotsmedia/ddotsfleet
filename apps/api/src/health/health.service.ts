import { Injectable } from "@nestjs/common";

export interface HealthReport {
  status: "ok" | "degraded";
  service: string;
  version: string;
  checks: Record<string, "ok" | "skipped">;
  timestamp: string;
}

// Task 01: no dependencies wired yet. DB/Redis checks are added in Task 02 / Task 03.
@Injectable()
export class HealthService {
  ready(): HealthReport {
    return {
      status: "ok",
      service: "fleetos-api",
      version: process.env.APP_VERSION ?? "0.1.0",
      checks: { database: "skipped", redis: "skipped" },
      timestamp: new Date().toISOString(),
    };
  }
}
