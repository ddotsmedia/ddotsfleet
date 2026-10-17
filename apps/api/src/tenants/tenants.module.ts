import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { LogMailTransport, MAIL_TRANSPORT } from "../common/mail.js";
import { InvitationsController } from "./invitations.controller.js";
import { TenantsController } from "./tenants.controller.js";
import { TenantsService } from "./tenants.service.js";

@Module({
  imports: [AuthModule, AccessModule],
  controllers: [TenantsController, InvitationsController],
  providers: [TenantsService, { provide: MAIL_TRANSPORT, useClass: LogMailTransport }],
})
export class TenantsModule {}
