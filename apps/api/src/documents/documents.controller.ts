import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
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
import { DocumentsService } from "./documents.service.js";
import {
  listDocumentsSchema,
  listRenewalsSchema,
  uploadDocumentSchema,
} from "./documents.schemas.js";

const idSchema = z.uuid();

@Controller("tenants/:tenantId/documents")
@UseGuards(SessionGuard, TenantGuard, PermissionsGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @RequirePermissions("document:read")
  async list(@TenantAccessContext() access: TenantAccess, @Query() query: Record<string, unknown>) {
    return {
      items: await this.documents.list(access.tenantId, parseInput(listDocumentsSchema, query)),
    };
  }

  @Post()
  @RequirePermissions("document:write")
  async upload(@TenantAccessContext() access: TenantAccess, @Body() body: unknown) {
    return this.documents.upload(access, parseInput(uploadDocumentSchema, body));
  }

  @Get(":documentId/file")
  @RequirePermissions("document:read")
  @Header("Cache-Control", "no-store")
  async download(
    @TenantAccessContext() access: TenantAccess,
    @Param("documentId") documentId: string,
  ) {
    const file = await this.documents.download(access, parseInput(idSchema, documentId));
    const safeName = file.fileName.replace(/[^A-Za-z0-9._-]/g, "_");
    return new StreamableFile(file.data, {
      type: file.contentType,
      disposition: `attachment; filename="${safeName}"`,
    });
  }
}

@Controller("tenants/:tenantId/renewals")
@UseGuards(SessionGuard, TenantGuard, PermissionsGuard)
export class RenewalsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @RequirePermissions("document:read")
  async list(@TenantAccessContext() access: TenantAccess, @Query() query: Record<string, unknown>) {
    return {
      items: await this.documents.listRenewals(
        access.tenantId,
        parseInput(listRenewalsSchema, query),
      ),
    };
  }

  @Post("reminders/run")
  @RequirePermissions("document:write")
  async runReminders(@TenantAccessContext() access: TenantAccess) {
    return this.documents.runReminders(access);
  }
}
