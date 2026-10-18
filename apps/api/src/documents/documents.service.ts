import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { TenantAccess } from "../access/access.service.js";
import { FILE_STORAGE, newObjectKey, sha256Hex, type FileStorage } from "./storage.js";
import {
  MAX_FILE_BYTES,
  type ListDocumentsQuery,
  type ListRenewalsQuery,
  type UploadDocumentInput,
} from "./documents.schemas.js";

const REMINDER_STAGES = [30, 14, 7, 0] as const;
const HORIZON_DAYS = 30;
const DAY_MS = 86_400_000;

// Magic-number checks: the declared content type must match the bytes, not just the client's claim.
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  "application/pdf": (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) =>
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
};

const DOCUMENT_SELECT = {
  id: true,
  subjectType: true,
  subjectId: true,
  docType: true,
  version: true,
  status: true,
  issuedOn: true,
  expiresOn: true,
  createdAt: true,
  // objectKey is deliberately not selected: storage keys never leave the service.
  fileObject: {
    select: { fileName: true, contentType: true, sizeBytes: true, scanStatus: true },
  },
} as const;

const RENEWAL_SELECT = {
  id: true,
  documentId: true,
  status: true,
  dueOn: true,
  createdAt: true,
  completedAt: true,
  document: { select: { subjectType: true, subjectId: true, docType: true } },
} as const;

function utcToday(): Date {
  return new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /**
   * Stores a new document version. The previous current version is superseded and its open renewal
   * completed in the same transaction. A replacement must extend the expiry (SRS renewal step 5).
   * Stored bytes are removed if the transaction fails.
   */
  async upload(access: TenantAccess, input: UploadDocumentInput) {
    const tenantId = access.tenantId;
    const data = Buffer.from(input.contentBase64, "base64");
    if (data.length === 0 || data.length > MAX_FILE_BYTES) {
      throw new BadRequestException("file_size_invalid");
    }
    if (!SIGNATURES[input.contentType]!(data)) {
      throw new BadRequestException("file_type_mismatch");
    }
    await this.assertSubject(tenantId, input.subjectType, input.subjectId);

    const objectKey = newObjectKey(tenantId);
    await this.storage.put(objectKey, data);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const scope = {
          tenantId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          docType: input.docType,
        };
        const previous = await tx.document.findFirst({
          where: { ...scope, status: "current" },
          select: { id: true, expiresOn: true },
        });
        if (previous?.expiresOn) {
          if (!input.expiresOn) throw new BadRequestException("expiry_required");
          if (input.expiresOn <= previous.expiresOn) {
            throw new ConflictException("expiry_not_extended");
          }
        }
        const last = await tx.document.findFirst({
          where: scope,
          orderBy: { version: "desc" },
          select: { version: true },
        });
        if (previous) {
          await tx.document.update({
            where: { id_tenantId: { id: previous.id, tenantId } },
            data: { status: "superseded" },
          });
          await tx.renewal.updateMany({
            where: { tenantId, documentId: previous.id, status: "open" },
            data: { status: "completed", completedAt: new Date(), completedBy: access.userId },
          });
        }

        const file = await tx.fileObject.create({
          data: {
            tenantId,
            objectKey,
            fileName: input.fileName,
            contentType: input.contentType,
            sizeBytes: data.length,
            sha256: sha256Hex(data),
            createdBy: access.userId,
          },
          select: { id: true },
        });
        const doc = await tx.document.create({
          data: {
            ...scope,
            version: (last?.version ?? 0) + 1,
            status: "current",
            issuedOn: input.issuedOn ?? null,
            expiresOn: input.expiresOn ?? null,
            fileObjectId: file.id,
            createdBy: access.userId,
          },
          select: DOCUMENT_SELECT,
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: "document",
          entityId: doc.id,
          action: "upload",
          changes: {
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            docType: input.docType,
            version: doc.version,
            expiresOn: input.expiresOn ?? null,
            supersedes: previous?.id ?? null,
          },
        });
        return doc;
      });
    } catch (e) {
      await this.storage.delete(objectKey).catch(() => undefined);
      if ((e as { code?: string }).code === "P2002") {
        throw new ConflictException("document_conflict");
      }
      throw e;
    }
  }

  async list(tenantId: string, query: ListDocumentsQuery) {
    return this.prisma.document.findMany({
      where: {
        tenantId,
        ...(query.subjectType ? { subjectType: query.subjectType } : {}),
        ...(query.subjectId ? { subjectId: query.subjectId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      select: DOCUMENT_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: query.limit,
    });
  }

  /** Returns bytes only after the malware scan has passed. Every download is audited. */
  async download(access: TenantAccess, documentId: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId: access.tenantId },
      select: {
        id: true,
        fileObject: {
          select: { objectKey: true, fileName: true, contentType: true, scanStatus: true },
        },
      },
    });
    if (!doc) throw new NotFoundException("document_not_found");
    if (doc.fileObject.scanStatus !== "clean") throw new ConflictException("file_not_scanned");

    const data = await this.storage.get(doc.fileObject.objectKey);
    await this.prisma.$transaction(async (tx) => {
      await this.audit.record(tx, {
        tenantId: access.tenantId,
        actorUserId: access.userId,
        entityType: "document",
        entityId: doc.id,
        action: "download",
        changes: {},
      });
    });
    return {
      data,
      contentType: doc.fileObject.contentType,
      fileName: doc.fileObject.fileName,
    };
  }

  /** Records the malware scan verdict. Called by the scanner worker, never exposed as a route. */
  async recordScanResult(tenantId: string, fileObjectId: string, verdict: "clean" | "rejected") {
    const result = await this.prisma.fileObject.updateMany({
      where: { id: fileObjectId, tenantId, scanStatus: "pending" },
      data: { scanStatus: verdict, scannedAt: new Date() },
    });
    return result.count === 1;
  }

  async listRenewals(tenantId: string, query: ListRenewalsQuery) {
    return this.prisma.renewal.findMany({
      where: { tenantId, status: query.status },
      select: RENEWAL_SELECT,
      orderBy: [{ dueOn: "asc" }, { id: "asc" }],
      take: query.limit,
    });
  }

  /**
   * Idempotent renewal scan. Opens one renewal per current document expiring within the horizon,
   * then records each reminder stage once. createMany with skipDuplicates relies on the unique
   * indexes, so reruns and concurrent runs never duplicate tasks or reminders.
   */
  async runReminders(access: TenantAccess) {
    const tenantId = access.tenantId;
    const today = utcToday();
    const horizon = new Date(today.getTime() + HORIZON_DAYS * DAY_MS);

    return this.prisma.$transaction(async (tx) => {
      const expiring = await tx.document.findMany({
        where: { tenantId, status: "current", expiresOn: { lte: horizon } },
        select: { id: true, expiresOn: true },
      });
      const opened = await tx.renewal.createMany({
        data: expiring.map((d) => ({ tenantId, documentId: d.id, dueOn: d.expiresOn! })),
        skipDuplicates: true,
      });

      const open = await tx.renewal.findMany({
        where: { tenantId, status: "open", dueOn: { lte: horizon } },
        select: { id: true, dueOn: true },
      });
      const reminders = open.flatMap((r) => {
        const daysUntil = Math.round((r.dueOn.getTime() - today.getTime()) / DAY_MS);
        return REMINDER_STAGES.filter((stage) => daysUntil <= stage).map((stage) => ({
          tenantId,
          renewalId: r.id,
          stageDays: stage,
        }));
      });
      const recorded = await tx.renewalReminder.createMany({
        data: reminders,
        skipDuplicates: true,
      });

      if (opened.count > 0 || recorded.count > 0) {
        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: "renewal",
          entityId: tenantId,
          action: "reminders_run",
          changes: { renewalsOpened: opened.count, remindersRecorded: recorded.count },
        });
      }
      return { renewalsOpened: opened.count, remindersRecorded: recorded.count };
    });
  }

  /** Tenant-scoped subject check. Subjects are polymorphic, so no database FK covers them. */
  private async assertSubject(
    tenantId: string,
    subjectType: "vehicle" | "driver",
    subjectId: string,
  ): Promise<void> {
    const found =
      subjectType === "vehicle"
        ? await this.prisma.vehicle.findFirst({
            where: { id: subjectId, tenantId },
            select: { id: true },
          })
        : await this.prisma.driver.findFirst({
            where: { id: subjectId, tenantId },
            select: { id: true },
          });
    if (!found) throw new NotFoundException("subject_not_found");
  }
}
