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
import { MaintenanceService } from "./maintenance.service.js";
import {
  clearDefectSchema,
  completeWorkOrderSchema,
  createPlanSchema,
  createWorkOrderSchema,
  dispatchStatusSchema,
  listDefectsSchema,
  listPlansSchema,
  listWorkOrdersSchema,
  reportDefectSchema,
  serviceHistorySchema,
} from "./maintenance.schemas.js";

const idSchema = z.uuid();

@Controller("tenants/:tenantId/maintenance")
@UseGuards(SessionGuard, TenantGuard, PermissionsGuard)
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Get("plans")
  @RequirePermissions("maintenance:read")
  async listPlans(
    @TenantAccessContext() access: TenantAccess,
    @Query() query: Record<string, unknown>,
  ) {
    return {
      items: await this.maintenance.listPlans(access.tenantId, parseInput(listPlansSchema, query)),
    };
  }

  @Post("plans")
  @RequirePermissions("maintenance:write")
  async createPlan(@TenantAccessContext() access: TenantAccess, @Body() body: unknown) {
    return this.maintenance.createPlan(access, parseInput(createPlanSchema, body));
  }

  @Get("work-orders")
  @RequirePermissions("maintenance:read")
  async listWorkOrders(
    @TenantAccessContext() access: TenantAccess,
    @Query() query: Record<string, unknown>,
  ) {
    return {
      items: await this.maintenance.listWorkOrders(
        access.tenantId,
        parseInput(listWorkOrdersSchema, query),
      ),
    };
  }

  @Post("work-orders")
  @RequirePermissions("maintenance:write")
  async createWorkOrder(@TenantAccessContext() access: TenantAccess, @Body() body: unknown) {
    return this.maintenance.createWorkOrder(access, parseInput(createWorkOrderSchema, body));
  }

  @Post("work-orders/:workOrderId/approve")
  @RequirePermissions("maintenance:write")
  async approve(
    @TenantAccessContext() access: TenantAccess,
    @Param("workOrderId") workOrderId: string,
  ) {
    return this.maintenance.approveWorkOrder(access, parseInput(idSchema, workOrderId));
  }

  @Post("work-orders/:workOrderId/cancel")
  @RequirePermissions("maintenance:write")
  async cancel(
    @TenantAccessContext() access: TenantAccess,
    @Param("workOrderId") workOrderId: string,
  ) {
    return this.maintenance.cancelWorkOrder(access, parseInput(idSchema, workOrderId));
  }

  @Post("work-orders/:workOrderId/complete")
  @RequirePermissions("maintenance:write")
  async complete(
    @TenantAccessContext() access: TenantAccess,
    @Param("workOrderId") workOrderId: string,
    @Body() body: unknown,
  ) {
    return this.maintenance.completeWorkOrder(
      access,
      parseInput(idSchema, workOrderId),
      parseInput(completeWorkOrderSchema, body),
    );
  }

  @Get("service-history")
  @RequirePermissions("maintenance:read")
  async serviceHistory(
    @TenantAccessContext() access: TenantAccess,
    @Query() query: Record<string, unknown>,
  ) {
    return {
      items: await this.maintenance.serviceHistory(
        access.tenantId,
        parseInput(serviceHistorySchema, query),
      ),
    };
  }

  @Get("defects")
  @RequirePermissions("maintenance:read")
  async listDefects(
    @TenantAccessContext() access: TenantAccess,
    @Query() query: Record<string, unknown>,
  ) {
    return {
      items: await this.maintenance.listDefects(
        access.tenantId,
        parseInput(listDefectsSchema, query),
      ),
    };
  }

  /** Drivers report defects through inspection:write, so a driver can flag a problem on their vehicle. */
  @Post("defects")
  @RequirePermissions("inspection:write")
  async reportDefect(@TenantAccessContext() access: TenantAccess, @Body() body: unknown) {
    return this.maintenance.reportDefect(access, parseInput(reportDefectSchema, body));
  }

  @Post("defects/:defectId/clear")
  @RequirePermissions("maintenance:write")
  async clearDefect(
    @TenantAccessContext() access: TenantAccess,
    @Param("defectId") defectId: string,
    @Body() body: unknown,
  ) {
    return this.maintenance.clearDefect(
      access,
      parseInput(idSchema, defectId),
      parseInput(clearDefectSchema, body),
    );
  }

  @Get("dispatch-status")
  @RequirePermissions("maintenance:read")
  async dispatchStatus(
    @TenantAccessContext() access: TenantAccess,
    @Query() query: Record<string, unknown>,
  ) {
    const { vehicleId } = parseInput(dispatchStatusSchema, query);
    return this.maintenance.dispatchStatus(access.tenantId, vehicleId);
  }
}
