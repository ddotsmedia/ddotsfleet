import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
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
import { VehicleImportService } from "./vehicle-import.service.js";
import {
  createVehicleSchema,
  listVehiclesSchema,
  updateVehicleSchema,
} from "./vehicles.schemas.js";

const vehicleIdSchema = z.uuid();
const importSchema = z.object({
  csv: z
    .string()
    .min(1)
    .max(10 * 1024 * 1024),
});

@Controller("tenants/:tenantId/vehicles")
@UseGuards(SessionGuard, TenantGuard, PermissionsGuard)
export class VehiclesController {
  constructor(
    private readonly vehicles: VehiclesService,
    private readonly imports: VehicleImportService,
  ) {}

  // Declared before ":vehicleId" so the literal path "export" is not parsed as an id.
  @Get("export")
  @RequirePermissions("vehicle:read")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="vehicles.csv"')
  async export(@TenantAccessContext() access: TenantAccess) {
    return this.imports.exportCsv(access.tenantId);
  }

  @Post("imports")
  @RequirePermissions("vehicle:write")
  async preview(@TenantAccessContext() access: TenantAccess, @Body() body: unknown) {
    const { csv } = parseInput(importSchema, body);
    return this.imports.preview(access, csv);
  }

  @Post("imports/:importId/commit")
  @HttpCode(200)
  @RequirePermissions("vehicle:write")
  async commitImport(
    @TenantAccessContext() access: TenantAccess,
    @Param("importId") importId: string,
  ) {
    return this.imports.commit(access, parseInput(vehicleIdSchema, importId));
  }

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
