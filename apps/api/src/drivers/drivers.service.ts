import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { TenantAccess } from "../access/access.service.js";
import type {
  CreateDriverInput,
  CreateLicenceInput,
  ListDriversQuery,
  UpdateDriverInput,
} from "./drivers.schemas.js";

const DRIVER_SELECT = {
  id: true,
  employeeCode: true,
  fullName: true,
  phone: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Licence numbers are personal data: audit records the class and expiry, never the number.
const LICENCE_SELECT = {
  id: true,
  issuingCountry: true,
  licenceClasses: true,
  expiresAt: true,
  createdAt: true,
} as const;

@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, query: ListDriversQuery) {
    const rows = await this.prisma.driver.findMany({
      where: {
        tenantId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.q
          ? {
              OR: [
                { employeeCode: { contains: query.q.toUpperCase() } },
                { fullName: { contains: query.q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: DRIVER_SELECT,
      orderBy: { id: "asc" },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }

  async get(tenantId: string, driverId: string) {
    const driver = await this.prisma.driver.findFirst({
      where: { id: driverId, tenantId },
      select: {
        ...DRIVER_SELECT,
        licences: { select: LICENCE_SELECT, orderBy: { expiresAt: "desc" } },
        assignments: {
          where: { status: "active" },
          select: { id: true, vehicleId: true, startAt: true, startOdometer: true },
          take: 1,
        },
      },
    });
    if (!driver) throw new NotFoundException("driver_not_found");
    return driver;
  }

  async create(access: TenantAccess, input: CreateDriverInput) {
    await this.assertUniqueCode(access.tenantId, input.employeeCode);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const driver = await tx.driver.create({
          data: {
            ...input,
            tenantId: access.tenantId,
            createdBy: access.userId,
            updatedBy: access.userId,
          },
          select: DRIVER_SELECT,
        });
        await this.audit.record(tx, {
          tenantId: access.tenantId,
          actorUserId: access.userId,
          entityType: "driver",
          entityId: driver.id,
          action: "create",
          changes: {
            employeeCode: driver.employeeCode,
            fullName: driver.fullName,
            status: driver.status,
          },
        });
        return driver;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  /** Records from/to only for changed fields. Phone numbers are personal data, so only a change flag is audited. */
  async update(access: TenantAccess, driverId: string, input: UpdateDriverInput) {
    const existing = await this.prisma.driver.findFirst({
      where: { id: driverId, tenantId: access.tenantId },
      select: DRIVER_SELECT,
    });
    if (!existing) throw new NotFoundException("driver_not_found");

    const current = existing as unknown as Record<string, unknown>;
    const changes: Record<string, { from: unknown; to: unknown } | { changed: true }> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const before = current[key] ?? null;
      if (before === value) continue;
      changes[key] =
        key === "phone" || key === "linkedUserId" ? { changed: true } : { from: before, to: value };
    }
    if (Object.keys(changes).length === 0) return existing;

    if (input.linkedUserId) {
      // A driver can only be linked to a user who is an active member of this tenant.
      const membership = await this.prisma.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: access.tenantId, userId: input.linkedUserId } },
        select: { status: true },
      });
      if (!membership || membership.status !== "active")
        throw new BadRequestException("user_not_member");
    }

    if (input.status && input.status !== "active") {
      const active = await this.prisma.vehicleAssignment.findFirst({
        where: { tenantId: access.tenantId, driverId, status: "active" },
        select: { id: true },
      });
      if (active) throw new ConflictException("driver_has_active_assignment");
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.driver.update({
          where: { id_tenantId: { id: driverId, tenantId: access.tenantId } },
          data: { ...input, updatedBy: access.userId },
          select: DRIVER_SELECT,
        });
        await this.audit.record(tx, {
          tenantId: access.tenantId,
          actorUserId: access.userId,
          entityType: "driver",
          entityId: driverId,
          action: "update",
          changes,
        });
        return updated;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  async addLicence(access: TenantAccess, driverId: string, input: CreateLicenceInput) {
    const driver = await this.prisma.driver.findFirst({
      where: { id: driverId, tenantId: access.tenantId },
      select: { id: true },
    });
    if (!driver) throw new NotFoundException("driver_not_found");

    const clash = await this.prisma.driverLicence.findFirst({
      where: {
        tenantId: access.tenantId,
        issuingCountry: input.issuingCountry,
        licenceNumber: input.licenceNumber,
      },
      select: { id: true },
    });
    if (clash) throw new ConflictException("licence_exists");

    try {
      return await this.prisma.$transaction(async (tx) => {
        const licence = await tx.driverLicence.create({
          data: {
            ...input,
            tenantId: access.tenantId,
            driverId,
            createdBy: access.userId,
          },
          select: LICENCE_SELECT,
        });
        await this.audit.record(tx, {
          tenantId: access.tenantId,
          actorUserId: access.userId,
          entityType: "driver_licence",
          entityId: licence.id,
          action: "create",
          changes: {
            driverId,
            issuingCountry: licence.issuingCountry,
            licenceClasses: licence.licenceClasses,
            expiresAt: licence.expiresAt,
          },
        });
        return licence;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  private async assertUniqueCode(tenantId: string, employeeCode: string): Promise<void> {
    const clash = await this.prisma.driver.findFirst({
      where: { tenantId, employeeCode },
      select: { id: true },
    });
    if (clash) throw new ConflictException("driver_code_exists");
  }

  private mapConflict(e: unknown): unknown {
    if ((e as { code?: string }).code !== "P2002") return e;
    return new ConflictException("driver_conflict");
  }
}
