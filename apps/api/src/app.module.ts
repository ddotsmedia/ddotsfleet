import { Module } from "@nestjs/common";
import { AccessModule } from "./access/access.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { DocumentsModule } from "./documents/documents.module.js";
import { DriversModule } from "./drivers/drivers.module.js";
import { OperationsModule } from "./operations/operations.module.js";
import { MaintenanceModule } from "./maintenance/maintenance.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { TenantsModule } from "./tenants/tenants.module.js";
import { VehiclesModule } from "./vehicles/vehicles.module.js";

@Module({
  imports: [
    DatabaseModule,
    HealthModule,
    AuthModule,
    AccessModule,
    TenantsModule,
    VehiclesModule,
    DriversModule,
    OperationsModule,
    DocumentsModule,
    MaintenanceModule,
  ],
})
export class AppModule {}
