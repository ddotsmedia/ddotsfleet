import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { MaintenanceModule } from "../maintenance/maintenance.module.js";
import {
  CheckoutsController,
  InspectionsController,
  ShiftsController,
} from "./operations.controller.js";
import { OperationsService } from "./operations.service.js";

@Module({
  imports: [AuthModule, AccessModule, AuditModule, MaintenanceModule],
  controllers: [ShiftsController, CheckoutsController, InspectionsController],
  providers: [OperationsService],
})
export class OperationsModule {}
