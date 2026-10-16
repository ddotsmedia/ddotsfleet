import { Controller, Get, HttpCode, HttpStatus } from "@nestjs/common";
import { HealthService, HealthReport } from "./health.service.js";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("live")
  @HttpCode(HttpStatus.OK)
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  ready(): HealthReport {
    return this.health.ready();
  }
}
