import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { VehiclesController } from "./vehicles.controller.js";
import { VehiclesService } from "./vehicles.service.js";
import { VehicleImportService } from "./vehicle-import.service.js";

@Module({
  imports: [AuthModule, AccessModule, AuditModule],
  controllers: [VehiclesController],
  providers: [VehiclesService, VehicleImportService],
})
export class VehiclesModule {}
