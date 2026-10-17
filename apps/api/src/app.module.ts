import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { TenantsModule } from "./tenants/tenants.module.js";

@Module({ imports: [DatabaseModule, HealthModule, AuthModule, TenantsModule] })
export class AppModule {}
