import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { SessionGuard } from "../auth/session.guard.js";
import {
  PermissionsGuard,
  RequirePermissions,
  TenantAccessContext,
  TenantGuard,
} from "../access/access.guards.js";
import type { TenantAccess } from "../access/access.service.js";
import { parseInput } from "../common/validation.js";
import { OperationsService } from "./operations.service.js";
import {
  endShiftSchema,
  listCheckoutsSchema,
  listInspectionsSchema,
  listShiftsSchema,
  openCheckoutSchema,
  recordInspectionSchema,
  returnCheckoutSchema,
  shiftEventSchema,
  startShiftSchema,
} from "./operations.schemas.js";

const idSchema = z.uuid();

@Controller("tenants/:tenantId/shifts")
@UseGuards(SessionGuard, TenantGuard, PermissionsGuard)
export class ShiftsController {
  constructor(private readonly operations: OperationsService) {}

  @Get()
  @RequirePermissions("shift:read")
  async list(@TenantAccessContext() access: TenantAccess, @Query() query: Record<string, unknown>) {
    return {
      items: await this.operations.listShifts(access.tenantId, parseInput(listShiftsSchema, query)),
    };
  }

  /** The caller's own open shifts. Drivers hold shift:write but not shift:read. */
  @Get("mine")
  @RequirePermissions("shift:write")
  async mine(@TenantAccessContext() access: TenantAccess) {
    return { items: await this.operations.listOwnOpenShifts(access) };
  }

  @Post()
  @RequirePermissions("shift:write")
  async start(@TenantAccessContext() access: TenantAccess, @Body() body: unknown) {
    return this.operations.startShift(access, parseInput(startShiftSchema, body));
  }

  @Post(":shiftId/events")
  @RequirePermissions("shift:write")
  async event(
    @TenantAccessContext() access: TenantAccess,
    @Param("shiftId") shiftId: string,
    @Body() body: unknown,
  ) {
    return this.operations.recordShiftEvent(
      access,
      parseInput(idSchema, shiftId),
      parseInput(shiftEventSchema, body),
    );
  }

  @Post(":shiftId/end")
  @RequirePermissions("shift:write")
  async end(
    @TenantAccessContext() access: TenantAccess,
    @Param("shiftId") shiftId: string,
    @Body() body: unknown,
  ) {
    return this.operations.endShift(
      access,
      parseInput(idSchema, shiftId),
      parseInput(endShiftSchema, body ?? {}),
    );
  }
}

@Controller("tenants/:tenantId/checkouts")
@UseGuards(SessionGuard, TenantGuard, PermissionsGuard)
export class CheckoutsController {
  constructor(private readonly operations: OperationsService) {}

  @Get()
  @RequirePermissions("vehicle:read")
  async list(@TenantAccessContext() access: TenantAccess, @Query() query: Record<string, unknown>) {
    return {
      items: await this.operations.listCheckouts(
        access.tenantId,
        parseInput(listCheckoutsSchema, query),
      ),
    };
  }

  @Post()
  @RequirePermissions("checkout:write")
  async open(@TenantAccessContext() access: TenantAccess, @Body() body: unknown) {
    return this.operations.openCheckout(access, parseInput(openCheckoutSchema, body));
  }

  @Post(":checkoutId/return")
  @RequirePermissions("checkout:write")
  async returnVehicle(
    @TenantAccessContext() access: TenantAccess,
    @Param("checkoutId") checkoutId: string,
    @Body() body: unknown,
  ) {
    return this.operations.returnCheckout(
      access,
      parseInput(idSchema, checkoutId),
      parseInput(returnCheckoutSchema, body),
    );
  }
}

@Controller("tenants/:tenantId/inspections")
@UseGuards(SessionGuard, TenantGuard, PermissionsGuard)
export class InspectionsController {
  constructor(private readonly operations: OperationsService) {}

  @Get()
  @RequirePermissions("vehicle:read")
  async list(@TenantAccessContext() access: TenantAccess, @Query() query: Record<string, unknown>) {
    return {
      items: await this.operations.listInspections(
        access.tenantId,
        parseInput(listInspectionsSchema, query),
      ),
    };
  }

  @Post()
  @RequirePermissions("inspection:write")
  async record(@TenantAccessContext() access: TenantAccess, @Body() body: unknown) {
    return this.operations.recordInspection(access, parseInput(recordInspectionSchema, body));
  }
}
