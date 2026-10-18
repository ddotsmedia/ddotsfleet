import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RoleCode } from "../generated/prisma/client.js";
import { CurrentAuth, SessionGuard } from "../auth/session.guard.js";
import { parseInput, type AuthContext } from "../common/validation.js";
import {
  PermissionsGuard,
  RequirePermissions,
  TenantAccessContext,
  TenantGuard,
} from "../access/access.guards.js";
import type { TenantAccess } from "../access/access.service.js";
import { TenantsService } from "./tenants.service.js";

const createTenantSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

const createInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  roleCode: z.enum(Object.values(RoleCode)),
});

@Controller("tenants")
@UseGuards(SessionGuard)
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Post()
  async create(@CurrentAuth() caller: AuthContext, @Body() body: unknown) {
    return this.tenants.createTenant(caller.userId, parseInput(createTenantSchema, body));
  }

  @Get(":tenantId")
  @UseGuards(TenantGuard)
  async get(@TenantAccessContext() access: TenantAccess) {
    return this.tenants.getTenant(access);
  }

  @Get(":tenantId/access")
  @UseGuards(TenantGuard)
  access(@TenantAccessContext() access: TenantAccess) {
    return this.tenants.accessProfile(access);
  }

  @Get(":tenantId/members")
  @UseGuards(TenantGuard, PermissionsGuard)
  @RequirePermissions("membership:manage")
  async members(@TenantAccessContext() access: TenantAccess) {
    return this.tenants.listMembers(access.tenantId);
  }

  @Post(":tenantId/invitations")
  @UseGuards(TenantGuard, PermissionsGuard)
  @RequirePermissions("membership:manage")
  async invite(@TenantAccessContext() access: TenantAccess, @Body() body: unknown) {
    return this.tenants.createInvitation(access, parseInput(createInvitationSchema, body));
  }
}
