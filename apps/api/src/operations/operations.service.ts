import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { TenantAccess } from "../access/access.service.js";
import { MaintenanceService } from "../maintenance/maintenance.service.js";
import { assertActsForDriver, loadActiveDriver } from "../access/driver-scope.js";
import type {
  EndShiftInput,
  ListCheckoutsQuery,
  ListInspectionsQuery,
  ListShiftsQuery,
  OpenCheckoutInput,
  RecordInspectionInput,
  ReturnCheckoutInput,
  ShiftEventInput,
  StartShiftInput,
} from "./operations.schemas.js";

const FUTURE_SKEW_MS = 5 * 60_000;

const SHIFT_SELECT = {
  id: true,
  driverId: true,
  status: true,
  startedAt: true,
  endedAt: true,
} as const;

const EVENT_SELECT = {
  id: true,
  shiftId: true,
  eventType: true,
  occurredAt: true,
  clientRef: true,
} as const;

const CHECKOUT_SELECT = {
  id: true,
  vehicleId: true,
  driverId: true,
  shiftId: true,
  status: true,
  openedAt: true,
  openingOdometer: true,
  openingFuelPercent: true,
  openingDamageNotes: true,
  returnedAt: true,
  closingOdometer: true,
  closingFuelPercent: true,
  closingDamageNotes: true,
} as const;

const INSPECTION_SELECT = {
  id: true,
  vehicleId: true,
  checkoutId: true,
  kind: true,
  result: true,
  performedAt: true,
  clientRef: true,
  items: { select: { code: true, label: true, answer: true, severity: true, notes: true } },
} as const;

@Injectable()
export class OperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly maintenance: MaintenanceService,
  ) {}

  // ---- shifts ------------------------------------------------------------

  async listShifts(tenantId: string, query: ListShiftsQuery) {
    return this.prisma.driverShift.findMany({
      where: { tenantId, driverId: query.driverId, status: query.status },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: query.limit,
      select: SHIFT_SELECT,
    });
  }

  /** Scoped to the driver linked to the caller's account; no link means no shifts. */
  async listOwnOpenShifts(access: TenantAccess) {
    const own = await this.prisma.driver.findFirst({
      where: { tenantId: access.tenantId, linkedUserId: access.userId },
      select: { id: true },
    });
    if (!own) return [];
    return this.prisma.driverShift.findMany({
      where: { tenantId: access.tenantId, driverId: own.id, status: "open" },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: 5,
      select: SHIFT_SELECT,
    });
  }

  /** One open shift per driver; the partial unique index is the backstop for concurrent starts. */
  async startShift(access: TenantAccess, input: StartShiftInput) {
    const tenantId = access.tenantId;
    await this.loadActiveDriver(tenantId, input.driverId);
    await this.assertActsForDriver(access, input.driverId);

    const now = Date.now();
    const startedAt = input.startedAt ? new Date(input.startedAt) : new Date(now);
    if (startedAt.getTime() > now + FUTURE_SKEW_MS) throw new BadRequestException("time_in_future");

    const open = await this.prisma.driverShift.findFirst({
      where: { tenantId, driverId: input.driverId, status: "open" },
      select: { id: true },
    });
    if (open) throw new ConflictException("shift_already_open");

    const lastClosed = await this.prisma.driverShift.findFirst({
      where: { tenantId, driverId: input.driverId, status: "closed" },
      orderBy: { endedAt: "desc" },
      select: { endedAt: true },
    });
    if (lastClosed?.endedAt && startedAt < lastClosed.endedAt) {
      throw new ConflictException("shift_overlaps_previous");
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const shift = await tx.driverShift.create({
          data: { tenantId, driverId: input.driverId, startedAt, startedBy: access.userId },
          select: SHIFT_SELECT,
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: "driver_shift",
          entityId: shift.id,
          action: "start",
          changes: { driverId: { to: input.driverId }, startedAt: { to: startedAt.toISOString() } },
        });
        return shift;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  /**
   * Break start/end. The shift row is locked (FOR UPDATE) so two concurrent break events
   * cannot both see the same prior state. clientRef makes retries from offline devices idempotent.
   */
  async recordShiftEvent(access: TenantAccess, shiftId: string, input: ShiftEventInput) {
    const tenantId = access.tenantId;
    if (input.clientRef) {
      const dup = await this.prisma.shiftEvent.findFirst({
        where: { tenantId, clientRef: input.clientRef },
        select: EVENT_SELECT,
      });
      if (dup) {
        if (dup.shiftId !== shiftId) throw new ConflictException("client_ref_conflict");
        return dup;
      }
    }

    const shift = await this.loadShift(tenantId, shiftId);
    await this.assertActsForDriver(access, shift.driverId);
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (occurredAt.getTime() > Date.now() + FUTURE_SKEW_MS) {
      throw new BadRequestException("time_in_future");
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockShift(tx, tenantId, shiftId);
        const current = await tx.driverShift.findFirst({
          where: { id: shiftId, tenantId },
          select: { status: true, startedAt: true },
        });
        if (!current || current.status !== "open") throw new ConflictException("shift_not_open");
        if (occurredAt < current.startedAt) throw new BadRequestException("event_before_shift");

        const last = await tx.shiftEvent.findFirst({
          where: { tenantId, shiftId },
          orderBy: [{ occurredAt: "desc" }, { receivedAt: "desc" }],
          select: { eventType: true, occurredAt: true },
        });
        if (last && occurredAt < last.occurredAt) throw new ConflictException("event_out_of_order");

        const onBreak = last?.eventType === "break_start";
        if (input.eventType === "break_start" && onBreak)
          throw new ConflictException("already_on_break");
        if (input.eventType === "break_end" && !onBreak)
          throw new ConflictException("not_on_break");

        const event = await tx.shiftEvent.create({
          data: {
            tenantId,
            shiftId,
            eventType: input.eventType,
            occurredAt,
            recordedBy: access.userId,
            clientRef: input.clientRef ?? null,
          },
          select: EVENT_SELECT,
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: "driver_shift",
          entityId: shiftId,
          action: input.eventType,
          changes: { occurredAt: { to: occurredAt.toISOString() } },
        });
        return event;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  async endShift(access: TenantAccess, shiftId: string, input: EndShiftInput) {
    const tenantId = access.tenantId;
    const shift = await this.loadShift(tenantId, shiftId);
    await this.assertActsForDriver(access, shift.driverId);
    const endedAt = input.endedAt ? new Date(input.endedAt) : new Date();
    if (endedAt.getTime() > Date.now() + FUTURE_SKEW_MS)
      throw new BadRequestException("time_in_future");

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockShift(tx, tenantId, shiftId);
        const current = await tx.driverShift.findFirst({
          where: { id: shiftId, tenantId },
          select: { status: true, startedAt: true },
        });
        if (!current || current.status !== "open") throw new ConflictException("shift_not_open");
        if (endedAt < current.startedAt) throw new BadRequestException("invalid_period");

        const last = await tx.shiftEvent.findFirst({
          where: { tenantId, shiftId },
          orderBy: [{ occurredAt: "desc" }, { receivedAt: "desc" }],
          select: { eventType: true, occurredAt: true },
        });
        if (last?.eventType === "break_start") throw new ConflictException("break_open");
        if (last && endedAt < last.occurredAt) throw new ConflictException("event_out_of_order");

        const updated = await tx.driverShift.update({
          where: { id_tenantId: { id: shiftId, tenantId } },
          data: { status: "closed", endedAt, endedBy: access.userId },
          select: SHIFT_SELECT,
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: "driver_shift",
          entityId: shiftId,
          action: "end",
          changes: { endedAt: { to: endedAt.toISOString() } },
        });
        return updated;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  // ---- checkouts ---------------------------------------------------------

  async listCheckouts(tenantId: string, query: ListCheckoutsQuery) {
    return this.prisma.vehicleCheckout.findMany({
      where: {
        tenantId,
        vehicleId: query.vehicleId,
        driverId: query.driverId,
        status: query.status,
      },
      orderBy: [{ openedAt: "desc" }, { id: "desc" }],
      take: query.limit,
      select: CHECKOUT_SELECT,
    });
  }

  /**
   * Vehicle and driver may each have one open checkout (partial unique indexes as backstop).
   * Dispatch is blocked while the vehicle has open critical defects (BR07).
   */
  async openCheckout(access: TenantAccess, input: OpenCheckoutInput) {
    const tenantId = access.tenantId;
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: input.vehicleId, tenantId },
      select: { status: true },
    });
    if (!vehicle) throw new NotFoundException("vehicle_not_found");
    if (vehicle.status !== "active") throw new ConflictException("vehicle_not_available");
    await this.maintenance.assertDispatchAllowed(tenantId, input.vehicleId);

    await this.loadActiveDriver(tenantId, input.driverId);
    await this.assertActsForDriver(access, input.driverId);

    if (input.shiftId) {
      const shift = await this.loadShift(tenantId, input.shiftId);
      if (shift.driverId !== input.driverId) throw new ConflictException("shift_driver_mismatch");
      if (shift.status !== "open") throw new ConflictException("shift_not_open");
    }

    const [vehicleOpen, driverOpen, lastReturn, lastService] = await Promise.all([
      this.prisma.vehicleCheckout.findFirst({
        where: { tenantId, vehicleId: input.vehicleId, status: "open" },
        select: { id: true },
      }),
      this.prisma.vehicleCheckout.findFirst({
        where: { tenantId, driverId: input.driverId, status: "open" },
        select: { id: true },
      }),
      this.prisma.vehicleCheckout.findFirst({
        where: { tenantId, vehicleId: input.vehicleId, status: "returned" },
        orderBy: { closingOdometer: "desc" },
        select: { closingOdometer: true },
      }),
      this.prisma.serviceEvent.findFirst({
        where: { tenantId, vehicleId: input.vehicleId },
        orderBy: { odometer: "desc" },
        select: { odometer: true },
      }),
    ]);
    if (vehicleOpen) throw new ConflictException("vehicle_already_checked_out");
    if (driverOpen) throw new ConflictException("driver_already_checked_out");

    const floor = Math.max(lastReturn?.closingOdometer ?? 0, lastService?.odometer ?? 0);
    if (input.openingOdometer < floor) throw new ConflictException("odometer_decreased");

    try {
      return await this.prisma.$transaction(async (tx) => {
        const checkout = await tx.vehicleCheckout.create({
          data: {
            tenantId,
            vehicleId: input.vehicleId,
            driverId: input.driverId,
            shiftId: input.shiftId ?? null,
            openedAt: new Date(),
            openingOdometer: input.openingOdometer,
            openingFuelPercent: input.openingFuelPercent,
            openingDamageNotes: input.openingDamageNotes ?? null,
            openedBy: access.userId,
          },
          select: CHECKOUT_SELECT,
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: "vehicle_checkout",
          entityId: checkout.id,
          action: "open",
          changes: {
            vehicleId: { to: input.vehicleId },
            driverId: { to: input.driverId },
            openingOdometer: { to: input.openingOdometer },
          },
        });
        return checkout;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  async returnCheckout(access: TenantAccess, checkoutId: string, input: ReturnCheckoutInput) {
    const tenantId = access.tenantId;
    const checkout = await this.prisma.vehicleCheckout.findFirst({
      where: { id: checkoutId, tenantId },
      select: { driverId: true, openingOdometer: true },
    });
    if (!checkout) throw new NotFoundException("checkout_not_found");
    await this.assertActsForDriver(access, checkout.driverId);
    if (input.closingOdometer < checkout.openingOdometer) {
      throw new ConflictException("odometer_decreased");
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM vehicle_checkouts WHERE id = ${checkoutId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
        const current = await tx.vehicleCheckout.findFirst({
          where: { id: checkoutId, tenantId },
          select: { status: true },
        });
        if (!current || current.status !== "open") throw new ConflictException("checkout_not_open");

        const updated = await tx.vehicleCheckout.update({
          where: { id_tenantId: { id: checkoutId, tenantId } },
          data: {
            status: "returned",
            returnedAt: new Date(),
            closingOdometer: input.closingOdometer,
            closingFuelPercent: input.closingFuelPercent,
            closingDamageNotes: input.closingDamageNotes ?? null,
            returnedBy: access.userId,
          },
          select: CHECKOUT_SELECT,
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: "vehicle_checkout",
          entityId: checkoutId,
          action: "return",
          changes: { closingOdometer: { to: input.closingOdometer } },
        });
        return updated;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  // ---- inspections -------------------------------------------------------

  async listInspections(tenantId: string, query: ListInspectionsQuery) {
    return this.prisma.inspection.findMany({
      where: { tenantId, vehicleId: query.vehicleId },
      orderBy: [{ performedAt: "desc" }, { id: "desc" }],
      take: query.limit,
      select: INSPECTION_SELECT,
    });
  }

  /**
   * Each failed item raises a Defect (Task 10). A critical defect then blocks dispatch.
   * clientRef makes retries from offline devices idempotent.
   */
  async recordInspection(access: TenantAccess, input: RecordInspectionInput) {
    const tenantId = access.tenantId;
    if (input.clientRef) {
      const dup = await this.prisma.inspection.findFirst({
        where: { tenantId, clientRef: input.clientRef },
        select: INSPECTION_SELECT,
      });
      if (dup) {
        if (dup.vehicleId !== input.vehicleId) throw new ConflictException("client_ref_conflict");
        return dup;
      }
    }

    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: input.vehicleId, tenantId },
      select: { id: true },
    });
    if (!vehicle) throw new NotFoundException("vehicle_not_found");
    if (input.checkoutId) {
      const checkout = await this.prisma.vehicleCheckout.findFirst({
        where: { id: input.checkoutId, tenantId },
        select: { vehicleId: true },
      });
      if (!checkout) throw new NotFoundException("checkout_not_found");
      if (checkout.vehicleId !== input.vehicleId)
        throw new BadRequestException("checkout_mismatch");
    }

    const failed = input.items.filter((item) => item.answer === "fail");
    const result = failed.length > 0 ? "fail" : "pass";

    try {
      return await this.prisma.$transaction(async (tx) => {
        const inspection = await tx.inspection.create({
          data: {
            tenantId,
            vehicleId: input.vehicleId,
            checkoutId: input.checkoutId ?? null,
            kind: input.kind,
            result,
            performedBy: access.userId,
            clientRef: input.clientRef ?? null,
            items: {
              create: input.items.map((item) => ({
                code: item.code,
                label: item.label,
                answer: item.answer,
                severity: item.answer === "fail" ? (item.severity ?? null) : null,
                notes: item.notes ?? null,
              })),
            },
          },
          select: { id: true },
        });

        for (const item of failed) {
          const defect = await tx.defect.create({
            data: {
              tenantId,
              vehicleId: input.vehicleId,
              severity: item.severity!,
              description: `${item.label} failed ${input.kind} inspection${item.notes ? `: ${item.notes}` : ""}`,
              reportedBy: access.userId,
            },
            select: { id: true },
          });
          await this.audit.record(tx, {
            tenantId,
            actorUserId: access.userId,
            entityType: "defect",
            entityId: defect.id,
            action: "report",
            changes: { severity: { to: item.severity }, source: { to: "inspection" } },
          });
        }

        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: "inspection",
          entityId: inspection.id,
          action: "record",
          changes: {
            vehicleId: { to: input.vehicleId },
            kind: { to: input.kind },
            result: { to: result },
            defectsRaised: { to: failed.length },
          },
        });

        return tx.inspection.findUniqueOrThrow({
          where: { id_tenantId: { id: inspection.id, tenantId } },
          select: INSPECTION_SELECT,
        });
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  // ---- helpers -----------------------------------------------------------

  private async loadShift(tenantId: string, shiftId: string) {
    const shift = await this.prisma.driverShift.findFirst({
      where: { id: shiftId, tenantId },
      select: { driverId: true, status: true },
    });
    if (!shift) throw new NotFoundException("shift_not_found");
    return shift;
  }

  private loadActiveDriver(tenantId: string, driverId: string) {
    return loadActiveDriver(this.prisma, tenantId, driverId);
  }

  private assertActsForDriver(access: TenantAccess, driverId: string): Promise<void> {
    return assertActsForDriver(this.prisma, access, driverId);
  }

  private async lockShift(
    tx: Prisma.TransactionClient,
    tenantId: string,
    shiftId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM driver_shifts WHERE id = ${shiftId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
  }

  private mapConflict(e: unknown): unknown {
    if ((e as { code?: string }).code !== "P2002") return e;
    return new ConflictException("conflict");
  }
}
