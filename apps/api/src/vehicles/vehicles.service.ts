import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { TenantAccess } from "../access/access.service.js";
import type {
  CreateVehicleInput,
  ListVehiclesQuery,
  UpdateVehicleInput,
} from "./vehicles.schemas.js";

const VEHICLE_SELECT = {
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
  createdAt: true,
  updatedAt: true,
} as const;

const ENTITY = "vehicle";

@Injectable()
export class VehiclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, query: ListVehiclesQuery) {
    const rows = await this.prisma.vehicle.findMany({
      where: {
        tenantId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.q
          ? {
              OR: [
                { plateNumber: { contains: query.q.toUpperCase() } },
                { fleetCode: { contains: query.q.toUpperCase() } },
                { make: { contains: query.q, mode: "insensitive" } },
                { model: { contains: query.q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: VEHICLE_SELECT,
      orderBy: { id: "asc" },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }

  async get(tenantId: string, vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, tenantId },
      select: VEHICLE_SELECT,
    });
    if (!vehicle) throw new NotFoundException("vehicle_not_found");
    return vehicle;
  }

  async create(access: TenantAccess, input: CreateVehicleInput) {
    await this.assertUnique(access.tenantId, input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const vehicle = await tx.vehicle.create({
          data: {
            ...input,
            tenantId: access.tenantId,
            createdBy: access.userId,
            updatedBy: access.userId,
          },
          select: VEHICLE_SELECT,
        });
        await this.audit.record(tx, {
          tenantId: access.tenantId,
          actorUserId: access.userId,
          entityType: ENTITY,
          entityId: vehicle.id,
          action: "create",
          changes: { created: vehicle },
        });
        return vehicle;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  /** Writes only changed fields and records a from/to diff. A no-op update writes no audit event. */
  async update(access: TenantAccess, vehicleId: string, input: UpdateVehicleInput) {
    const existing = await this.get(access.tenantId, vehicleId);
    const current = existing as unknown as Record<string, unknown>;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const before = current[key] ?? null;
      if (before !== value) changes[key] = { from: before, to: value };
    }
    if (Object.keys(changes).length === 0) return existing;
    await this.assertUnique(access.tenantId, input, vehicleId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.vehicle.update({
          where: { id_tenantId: { id: vehicleId, tenantId: access.tenantId } },
          data: { ...input, updatedBy: access.userId },
          select: VEHICLE_SELECT,
        });
        await this.audit.record(tx, {
          tenantId: access.tenantId,
          actorUserId: access.userId,
          entityType: ENTITY,
          entityId: vehicleId,
          action: "update",
          changes,
        });
        return updated;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  /** Explicit pre-check gives precise errors; the unique indexes remain the race-proof backstop. */
  private async assertUnique(
    tenantId: string,
    input: { plateNumber?: string; fleetCode?: string | null },
    exceptId?: string,
  ): Promise<void> {
    const or: { plateNumber?: string; fleetCode?: string }[] = [];
    if (input.plateNumber) or.push({ plateNumber: input.plateNumber });
    if (input.fleetCode) or.push({ fleetCode: input.fleetCode });
    if (or.length === 0) return;
    const clash = await this.prisma.vehicle.findFirst({
      where: { tenantId, OR: or, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { plateNumber: true },
    });
    if (!clash) return;
    throw new ConflictException(
      clash.plateNumber === input.plateNumber
        ? "vehicle_plate_exists"
        : "vehicle_fleet_code_exists",
    );
  }

  private mapConflict(e: unknown): unknown {
    if ((e as { code?: string }).code !== "P2002") return e;
    return new ConflictException("vehicle_conflict");
  }
}
