import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { AssignmentsController, DriversController } from "./drivers.controller.js";
import { DriversService } from "./drivers.service.js";
import { AssignmentsService } from "./assignments.service.js";

@Module({
  imports: [AuthModule, AccessModule, AuditModule],
  controllers: [DriversController, AssignmentsController],
  providers: [DriversService, AssignmentsService],
})
export class DriversModule {}
