import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { MaintenanceController } from "./maintenance.controller.js";
import { MaintenanceService } from "./maintenance.service.js";

@Module({
  imports: [AuthModule, AccessModule, AuditModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
