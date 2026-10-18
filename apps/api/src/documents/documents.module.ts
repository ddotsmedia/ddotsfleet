import { Module } from "@nestjs/common";
import path from "node:path";
import { AccessModule } from "../access/access.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { DocumentsController, RenewalsController } from "./documents.controller.js";
import { DocumentsService } from "./documents.service.js";
import { FILE_STORAGE, LocalFileStorage } from "./storage.js";

@Module({
  imports: [AuthModule, AccessModule, AuditModule],
  controllers: [DocumentsController, RenewalsController],
  providers: [
    DocumentsService,
    {
      provide: FILE_STORAGE,
      useFactory: () =>
        new LocalFileStorage(
          process.env.DOCUMENT_STORAGE_DIR ?? path.resolve(process.cwd(), "var/documents"),
        ),
    },
  ],
})
export class DocumentsModule {}
