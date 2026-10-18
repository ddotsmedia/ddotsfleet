import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
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
import { DriversService } from "./drivers.service.js";
import { AssignmentsService } from "./assignments.service.js";
import {
  createDriverSchema,
  createLicenceSchema,
  endAssignmentSchema,
  issueAssignmentSchema,
  listAssignmentsSchema,
  listDriversSchema,
  updateDriverSchema,
} from "./drivers.schemas.js";

const idSchema = z.uuid();

@Controller("tenants/:tenantId/drivers")
@UseGuards(SessionGuard, TenantGuard, PermissionsGuard)
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get()
  @RequirePermissions("driver:read")
  async list(@TenantAccessContext() access: TenantAccess, @Query() query: Record<string, unknown>) {
    return this.drivers.list(access.tenantId, parseInput(listDriversSchema, query));
  }

  @Post()
  @RequirePermissions("driver:write")
  async create(@TenantAccessContext() access: TenantAccess, @Body() body: unknown) {
    return this.drivers.create(access, parseInput(createDriverSchema, body));
  }

  @Get(":driverId")
  @RequirePermissions("driver:read")
  async get(@TenantAccessContext() access: TenantAccess, @Param("driverId") driverId: string) {
    return this.drivers.get(access.tenantId, parseInput(idSchema, driverId));
  }

  @Patch(":driverId")
  @RequirePermissions("driver:write")
  async update(
    @TenantAccessContext() access: TenantAccess,
    @Param("driverId") driverId: string,
    @Body() body: unknown,
  ) {
    return this.drivers.update(
      access,
      parseInput(idSchema, driverId),
      parseInput(updateDriverSchema, body),
    );
  }

  @Post(":driverId/licences")
  @RequirePermissions("driver:write")
  async addLicence(
    @TenantAccessContext() access: TenantAccess,
    @Param("driverId") driverId: string,
    @Body() body: unknown,
  ) {
    return this.drivers.addLicence(
      access,
      parseInput(idSchema, driverId),
      parseInput(createLicenceSchema, body),
    );
  }
}

@Controller("tenants/:tenantId/assignments")
@UseGuards(SessionGuard, TenantGuard, PermissionsGuard)
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get()
  @RequirePermissions("driver:read")
  async list(@TenantAccessContext() access: TenantAccess, @Query() query: Record<string, unknown>) {
    return {
      items: await this.assignments.list(access.tenantId, parseInput(listAssignmentsSchema, query)),
    };
  }

  @Post()
  @RequirePermissions("assignment:write")
  async issue(@TenantAccessContext() access: TenantAccess, @Body() body: unknown) {
    return this.assignments.issue(access, parseInput(issueAssignmentSchema, body));
  }

  @Post(":assignmentId/end")
  @RequirePermissions("assignment:write")
  async end(
    @TenantAccessContext() access: TenantAccess,
    @Param("assignmentId") assignmentId: string,
    @Body() body: unknown,
  ) {
    return this.assignments.end(
      access,
      parseInput(idSchema, assignmentId),
      parseInput(endAssignmentSchema, body),
    );
  }
}
