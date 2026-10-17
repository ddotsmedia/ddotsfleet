import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { CurrentAuth, SessionGuard } from "../auth/session.guard.js";
import { parseInput, type AuthContext } from "../common/validation.js";
import { TenantsService } from "./tenants.service.js";

const acceptSchema = z.object({ token: z.string().min(20).max(200) });

@Controller("auth/invitations")
@UseGuards(SessionGuard)
export class InvitationsController {
  constructor(private readonly tenants: TenantsService) {}

  @Post("accept")
  @HttpCode(200)
  async accept(@CurrentAuth() caller: AuthContext, @Body() body: unknown) {
    const { token } = parseInput(acceptSchema, body);
    return this.tenants.acceptInvitation(caller.userId, caller.email, token);
  }
}
