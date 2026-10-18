import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { TenantAccess } from "../access/access.service.js";
import type {
  EndAssignmentInput,
  IssueAssignmentInput,
  ListAssignmentsQuery,
} from "./drivers.schemas.js";

const ASSIGNMENT_SELECT = {
  id: true,
  vehicleId: true,
  driverId: true,
  status: true,
  startAt: true,
  endAt: true,
  startOdometer: true,
  endOdometer: true,
  licenceOverride: true,
  createdAt: true,
} as const;

const ENTITY = "vehicle_assignment";

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, query: ListAssignmentsQuery) {
    return this.prisma.vehicleAssignment.findMany({
      where: {
        tenantId,
        ...(query.vehicleId ? { vehicleId: query.vehicleId } : {}),
        ...(query.driverId ? { driverId: query.driverId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      select: ASSIGNMENT_SELECT,
      orderBy: [{ startAt: "desc" }, { id: "asc" }],
      take: query.limit,
    });
  }

  /**
   * Issues an exclusive vehicle hand-over. Business rules checked here: vehicle and driver must be
   * assignable; the driver needs an unexpired licence unless a written override reason is given (BR04);
   * the opening odometer may not be below the vehicle's last reading and the period may not overlap
   * the previous one (BR05). The partial unique indexes are the race-proof backstop for one active
   * assignment per vehicle and per driver.
   */
  async issue(access: TenantAccess, input: IssueAssignmentInput) {
    const tenantId = access.tenantId;
    const [vehicle, driver] = await Promise.all([
      this.prisma.vehicle.findFirst({
        where: { id: input.vehicleId, tenantId },
        select: { status: true },
      }),
      this.prisma.driver.findFirst({
        where: { id: input.driverId, tenantId },
        select: { status: true },
      }),
    ]);
    if (!vehicle) throw new NotFoundException("vehicle_not_found");
    if (!driver) throw new NotFoundException("driver_not_found");
    if (vehicle.status !== "active") throw new ConflictException("vehicle_not_assignable");
    if (driver.status !== "active") throw new ConflictException("driver_not_assignable");

    const startAt = input.startAt ?? new Date();
    const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
    const validLicences = await this.prisma.driverLicence.count({
      where: { tenantId, driverId: input.driverId, expiresAt: { gte: today } },
    });
    if (validLicences === 0 && !input.licenceOverrideReason) {
      throw new ConflictException("licence_not_valid");
    }

    const [activeVehicle, activeDriver, previous] = await Promise.all([
      this.prisma.vehicleAssignment.findFirst({
        where: { tenantId, vehicleId: input.vehicleId, status: "active" },
        select: { id: true },
      }),
      this.prisma.vehicleAssignment.findFirst({
        where: { tenantId, driverId: input.driverId, status: "active" },
        select: { id: true },
      }),
      this.prisma.vehicleAssignment.findFirst({
        where: { tenantId, vehicleId: input.vehicleId },
        orderBy: { startAt: "desc" },
        select: { startAt: true, startOdometer: true, endAt: true, endOdometer: true },
      }),
    ]);
    if (activeVehicle) throw new ConflictException("vehicle_already_assigned");
    if (activeDriver) throw new ConflictException("driver_already_assigned");
    if (previous) {
      if (startAt < (previous.endAt ?? previous.startAt)) {
        throw new ConflictException("assignment_overlaps_previous");
      }
      const lastReading = previous.endOdometer ?? previous.startOdometer;
      if (input.startOdometer < lastReading) throw new ConflictException("odometer_decreased");
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.vehicleAssignment.create({
          data: {
            tenantId,
            vehicleId: input.vehicleId,
            driverId: input.driverId,
            startAt,
            startOdometer: input.startOdometer,
            licenceOverride: input.licenceOverrideReason ?? null,
            createdBy: access.userId,
          },
          select: ASSIGNMENT_SELECT,
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: ENTITY,
          entityId: created.id,
          action: "create",
          changes: {
            vehicleId: created.vehicleId,
            driverId: created.driverId,
            startAt: created.startAt,
            startOdometer: created.startOdometer,
            licenceOverride: created.licenceOverride !== null,
          },
        });
        return created;
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") {
        throw new ConflictException("assignment_conflict");
      }
      throw e;
    }
  }

  /** Closes an active assignment. The status-guarded updateMany prevents two concurrent closes from both succeeding. */
  async end(access: TenantAccess, assignmentId: string, input: EndAssignmentInput) {
    const tenantId = access.tenantId;
    const existing = await this.prisma.vehicleAssignment.findFirst({
      where: { id: assignmentId, tenantId },
      select: { status: true, startAt: true, startOdometer: true },
    });
    if (!existing) throw new NotFoundException("assignment_not_found");
    if (existing.status !== "active") throw new ConflictException("assignment_not_active");

    const endAt = input.endAt ?? new Date();
    if (endAt < existing.startAt) throw new ConflictException("invalid_period");
    if (input.endOdometer < existing.startOdometer)
      throw new ConflictException("odometer_decreased");

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.vehicleAssignment.updateMany({
        where: { id: assignmentId, tenantId, status: "active" },
        data: {
          status: "ended",
          endAt,
          endOdometer: input.endOdometer,
          endedBy: access.userId,
        },
      });
      if (claimed.count === 0) throw new ConflictException("assignment_not_active");
      const ended = await tx.vehicleAssignment.findUniqueOrThrow({
        where: { id_tenantId: { id: assignmentId, tenantId } },
        select: ASSIGNMENT_SELECT,
      });
      await this.audit.record(tx, {
        tenantId,
        actorUserId: access.userId,
        entityType: ENTITY,
        entityId: assignmentId,
        action: "end",
        changes: {
          status: { from: "active", to: "ended" },
          endAt,
          endOdometer: input.endOdometer,
        },
      });
      return ended;
    });
  }
}
