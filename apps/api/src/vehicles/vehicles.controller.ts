import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard.js";
import {
  PermissionsGuard,
  RequirePermissions,
  TenantAccessContext,
  TenantGuard,
} from "../access/access.guards.js";
import type { TenantAccess } from "../access/access.service.js";
import { parseInput } from "../common/validation.js";
import { z } from "zod";
import { VehiclesService } from "./vehicles.service.js";
import {
  createVehicleSchema,
  listVehiclesSchema,
  updateVehicleSchema,
} from "./vehicles.schemas.js";

const vehicleIdSchema = z.uuid();

@Controller("tenants/:tenantId/vehicles")
@UseGuards(SessionGuard, TenantGuard, PermissionsGuard)
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Get()
  @RequirePermissions("vehicle:read")
  async list(@TenantAccessContext() access: TenantAccess, @Query() query: Record<string, unknown>) {
    return this.vehicles.list(access.tenantId, parseInput(listVehiclesSchema, query));
  }

  @Post()
  @RequirePermissions("vehicle:write")
  async create(@TenantAccessContext() access: TenantAccess, @Body() body: unknown) {
    return this.vehicles.create(access, parseInput(createVehicleSchema, body));
  }

  @Get(":vehicleId")
  @RequirePermissions("vehicle:read")
  async get(@TenantAccessContext() access: TenantAccess, @Param("vehicleId") vehicleId: string) {
    return this.vehicles.get(access.tenantId, parseInput(vehicleIdSchema, vehicleId));
  }

  @Patch(":vehicleId")
  @RequirePermissions("vehicle:write")
  async update(
    @TenantAccessContext() access: TenantAccess,
    @Param("vehicleId") vehicleId: string,
    @Body() body: unknown,
  ) {
    return this.vehicles.update(
      access,
      parseInput(vehicleIdSchema, vehicleId),
      parseInput(updateVehicleSchema, body),
    );
  }
}
