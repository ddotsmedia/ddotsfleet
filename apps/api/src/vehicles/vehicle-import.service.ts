import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { TenantAccess } from "../access/access.service.js";
import type { Prisma } from "../generated/prisma/client.js";
import { parseCsv, toCsv } from "./csv.js";
import { createVehicleSchema, type CreateVehicleInput } from "./vehicles.schemas.js";

export const MAX_IMPORT_ROWS = 10_000;
const IMPORT_TTL_MS = 24 * 60 * 60 * 1000;
const BATCH = 500;
const MAX_REPORTED_ERRORS = 200;

/** Column keys after normalising headers (case, spaces and underscores ignored). */
const COLUMN_KEYS = [
  "fleetCode",
  "plateNumber",
  "emirate",
  "vin",
  "category",
  "make",
  "model",
  "year",
  "colour",
  "fuelType",
  "ownership",
  "status",
] as const;
type ColumnKey = (typeof COLUMN_KEYS)[number];
const REQUIRED: ColumnKey[] = [
  "plateNumber",
  "emirate",
  "category",
  "make",
  "model",
  "fuelType",
  "ownership",
];

const normaliseHeader = (h: string): string => h.replace(/[\s_]/g, "").toLowerCase();
const KEY_BY_HEADER = new Map(COLUMN_KEYS.map((k) => [k.toLowerCase(), k]));

export interface RowError {
  row: number;
  errors: { field: string; message: string }[];
}

@Injectable()
export class VehicleImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Validates every row and stores a previewable job. Nothing is written to the fleet until commit. */
  async preview(access: TenantAccess, csv: string) {
    const checksum = createHash("sha256").update(csv).digest("hex");
    const grid = parseCsv(csv);
    if (grid.length < 2) throw new BadRequestException("empty_import");
    const columns = this.mapHeaders(grid[0]!);
    const dataRows = grid.slice(1);
    if (dataRows.length > MAX_IMPORT_ROWS) throw new BadRequestException("too_many_rows");

    const existing = await this.prisma.vehicle.findMany({
      where: { tenantId: access.tenantId },
      select: { plateNumber: true, fleetCode: true },
    });
    const takenPlates = new Set(existing.map((v) => v.plateNumber));
    const takenFleet = new Set(existing.flatMap((v) => (v.fleetCode ? [v.fleetCode] : [])));
    const seenPlates = new Set<string>();
    const seenFleet = new Set<string>();

    const payload: CreateVehicleInput[] = [];
    const rowErrors: RowError[] = [];
    dataRows.forEach((cells, idx) => {
      const row = idx + 1;
      const parsed = createVehicleSchema.safeParse(this.toInput(columns, cells));
      if (!parsed.success) {
        rowErrors.push({
          row,
          errors: parsed.error.issues.map((i) => ({
            field: String(i.path[0] ?? ""),
            message: i.message,
          })),
        });
        return;
      }
      const v = parsed.data;
      const errors: RowError["errors"] = [];
      if (takenPlates.has(v.plateNumber))
        errors.push({ field: "plateNumber", message: "duplicate_existing" });
      else if (seenPlates.has(v.plateNumber))
        errors.push({ field: "plateNumber", message: "duplicate_in_file" });
      if (v.fleetCode) {
        if (takenFleet.has(v.fleetCode))
          errors.push({ field: "fleetCode", message: "duplicate_existing" });
        else if (seenFleet.has(v.fleetCode))
          errors.push({ field: "fleetCode", message: "duplicate_in_file" });
      }
      if (errors.length > 0) {
        rowErrors.push({ row, errors });
        return;
      }
      seenPlates.add(v.plateNumber);
      if (v.fleetCode) seenFleet.add(v.fleetCode);
      payload.push(v);
    });

    const job = await this.prisma.importJob.create({
      data: {
        tenantId: access.tenantId,
        createdBy: access.userId,
        checksum,
        totalRows: dataRows.length,
        validRows: payload.length,
        errorRows: rowErrors.length,
        rowErrors: rowErrors as unknown as Prisma.InputJsonValue,
        payload: payload as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + IMPORT_TTL_MS),
      },
      select: {
        id: true,
        status: true,
        checksum: true,
        totalRows: true,
        validRows: true,
        errorRows: true,
        expiresAt: true,
      },
    });
    return {
      ...job,
      rowErrors: rowErrors.slice(0, MAX_REPORTED_ERRORS),
      rowErrorsTruncated: rowErrors.length > MAX_REPORTED_ERRORS,
    };
  }

  /** Commits a clean preview atomically. A job with any error cannot be committed. */
  async commit(access: TenantAccess, jobId: string) {
    const job = await this.prisma.importJob.findFirst({
      where: { id: jobId, tenantId: access.tenantId },
    });
    if (!job) throw new NotFoundException("import_not_found");
    if (job.status !== "previewed") throw new ConflictException("import_already_committed");
    if (job.expiresAt <= new Date()) throw new GoneException("import_expired");
    if (job.errorRows > 0) throw new ConflictException("import_has_errors");

    const now = new Date();
    const rows = job.payload as unknown as CreateVehicleInput[];
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Claim first so two concurrent commits of the same job cannot both insert.
        const claimed = await tx.importJob.updateMany({
          where: { id: jobId, tenantId: access.tenantId, status: "previewed" },
          data: { status: "committed", committedAt: now },
        });
        if (claimed.count !== 1) throw new ConflictException("import_already_committed");

        for (let i = 0; i < rows.length; i += BATCH) {
          await tx.vehicle.createMany({
            data: rows.slice(i, i + BATCH).map((r) => ({
              ...r,
              tenantId: access.tenantId,
              createdBy: access.userId,
              updatedBy: access.userId,
            })),
          });
        }
        await this.audit.record(tx, {
          tenantId: access.tenantId,
          actorUserId: access.userId,
          entityType: "vehicle_import",
          entityId: jobId,
          action: "commit",
          changes: { count: rows.length, checksum: job.checksum },
        });
        return { id: jobId, committed: rows.length };
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new ConflictException("import_conflict");
      throw e;
    }
  }

  async exportCsv(tenantId: string, headersOnly = false): Promise<string> {
    const headers = [
      "fleetCode",
      "plateNumber",
      "emirate",
      "vin",
      "category",
      "make",
      "model",
      "year",
      "colour",
      "fuelType",
      "ownership",
      "status",
    ];
    const rows: string[][] = [];
    if (!headersOnly) {
      let cursor: string | undefined;
      for (;;) {
        const batch = await this.prisma.vehicle.findMany({
          where: { tenantId },
          orderBy: { id: "asc" },
          take: 1000,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            fleetCode: true,
            plateNumber: true,
            emirate: true,
            vin: true,
            category: true,
            make: true,
            model: true,
            year: true,
            colour: true,
            fuelType: true,
            ownership: true,
            status: true,
          },
        });
        for (const v of batch) {
          rows.push([
            v.fleetCode ?? "",
            v.plateNumber,
            v.emirate,
            v.vin ?? "",
            v.category,
            v.make,
            v.model,
            v.year === null ? "" : String(v.year),
            v.colour ?? "",
            v.fuelType,
            v.ownership,
            v.status,
          ]);
        }
        if (batch.length < 1000) break;
        cursor = batch[batch.length - 1]!.id;
      }
    }
    return toCsv(headers, rows);
  }

  private mapHeaders(header: string[]): (ColumnKey | null)[] {
    const keys = header.map((h) => KEY_BY_HEADER.get(normaliseHeader(h)) ?? null);
    const unknown = header.filter((_, i) => keys[i] === null);
    if (unknown.length > 0) throw new BadRequestException("unknown_columns");
    const present = new Set(keys);
    if (present.size !== keys.length) throw new BadRequestException("duplicate_columns");
    if (REQUIRED.some((k) => !present.has(k))) throw new BadRequestException("missing_columns");
    return keys;
  }

  private toInput(columns: (ColumnKey | null)[], cells: string[]): Record<string, unknown> {
    const input: Record<string, unknown> = {};
    columns.forEach((key, i) => {
      if (!key) return;
      const raw = (cells[i] ?? "").trim();
      if (raw === "") return;
      input[key] = key === "year" ? Number(raw) : raw;
    });
    return input;
  }
}
