import { Module } from "@nestjs/common";
import { AccessService } from "./access.service.js";
import { PermissionsGuard, TenantGuard } from "./access.guards.js";

@Module({
  providers: [AccessService, TenantGuard, PermissionsGuard],
  exports: [AccessService, TenantGuard, PermissionsGuard],
})
export class AccessModule {}
