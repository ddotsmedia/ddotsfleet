import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { MaintenanceModule } from "../maintenance/maintenance.module.js";
import { DispatchService } from "./dispatch.service.js";
import { JobsController, ReviewsController, TripsController } from "./dispatch.controller.js";

@Module({
  imports: [AuthModule, AccessModule, AuditModule, MaintenanceModule],
  controllers: [TripsController, JobsController, ReviewsController],
  providers: [DispatchService],
})
export class DispatchModule {}
