import { Injectable } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";

export interface AuditRecord {
  tenantId: string;
  actorUserId: string;
  entityType: string;
  entityId: string;
  action: string;
  changes: unknown;
}

/** Writes append-only audit events inside the caller's transaction, so a change and its audit commit together. */
@Injectable()
export class AuditService {
  async record(tx: Prisma.TransactionClient, event: AuditRecord): Promise<void> {
    await tx.auditEvent.create({
      data: { ...event, changes: event.changes as Prisma.InputJsonValue },
    });
  }
}
