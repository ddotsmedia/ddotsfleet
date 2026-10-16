import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RoleCode } from "../generated/prisma/client.js";
import { CurrentAuth, SessionGuard } from "../auth/session.guard.js";
import { parseInput, type AuthContext } from "../common/validation.js";
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

const tenantIdSchema = z.uuid();

@Controller("tenants")
@UseGuards(SessionGuard)
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Post()
  async create(@CurrentAuth() caller: AuthContext, @Body() body: unknown) {
    return this.tenants.createTenant(caller.userId, parseInput(createTenantSchema, body));
  }

  @Post(":tenantId/invitations")
  async invite(
    @CurrentAuth() caller: AuthContext,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ) {
    const id = parseInput(tenantIdSchema, tenantId);
    return this.tenants.createInvitation(
      caller.userId,
      id,
      parseInput(createInvitationSchema, body),
    );
  }
}
