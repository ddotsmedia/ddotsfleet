import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { TenantAccess } from "../access/access.service.js";
import type {
  ClearDefectInput,
  CompleteWorkOrderInput,
  CreatePlanInput,
  CreateWorkOrderInput,
  ListDefectsQuery,
  ListPlansQuery,
  ListWorkOrdersQuery,
  ReportDefectInput,
  ServiceHistoryQuery,
} from "./maintenance.schemas.js";

const DAY_MS = 86_400_000;

const PLAN_SELECT = {
  id: true,
  vehicleId: true,
  name: true,
  intervalKm: true,
  intervalDays: true,
  nextDueOdometer: true,
  nextDueDate: true,
  status: true,
  createdAt: true,
} as const;

const WORK_ORDER_SELECT = {
  id: true,
  vehicleId: true,
  planId: true,
  title: true,
  status: true,
  vendorName: true,
  labourFils: true,
  partsFils: true,
  invoiceNumber: true,
  createdBy: true,
  approvedAt: true,
  completedAt: true,
  cancelledAt: true,
  createdAt: true,
} as const;

const DEFECT_SELECT = {
  id: true,
  vehicleId: true,
  severity: true,
  status: true,
  description: true,
  reportedAt: true,
  clearedAt: true,
  clearanceNote: true,
} as const;

@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---- Plans -------------------------------------------------------------

  async listPlans(tenantId: string, query: ListPlansQuery) {
    return this.prisma.maintenancePlan.findMany({
      where: {
        tenantId,
        ...(query.vehicleId ? { vehicleId: query.vehicleId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      select: PLAN_SELECT,
      orderBy: [{ nextDueDate: "asc" }, { id: "asc" }],
      take: query.limit,
    });
  }

  async createPlan(access: TenantAccess, input: CreatePlanInput) {
    await this.assertVehicle(access.tenantId, input.vehicleId);
    return this.prisma.$transaction(async (tx) => {
      const plan = await tx.maintenancePlan.create({
        data: {
          tenantId: access.tenantId,
          vehicleId: input.vehicleId,
          name: input.name,
          intervalKm: input.intervalKm ?? null,
          intervalDays: input.intervalDays ?? null,
          nextDueOdometer: input.nextDueOdometer ?? null,
          nextDueDate: input.nextDueDate ?? null,
          createdBy: access.userId,
        },
        select: PLAN_SELECT,
      });
      await this.audit.record(tx, {
        tenantId: access.tenantId,
        actorUserId: access.userId,
        entityType: "maintenance_plan",
        entityId: plan.id,
        action: "create",
        changes: {
          vehicleId: plan.vehicleId,
          name: plan.name,
          intervalKm: plan.intervalKm,
          intervalDays: plan.intervalDays,
        },
      });
      return plan;
    });
  }

  // ---- Work orders -------------------------------------------------------

  async listWorkOrders(tenantId: string, query: ListWorkOrdersQuery) {
    return this.prisma.workOrder.findMany({
      where: {
        tenantId,
        ...(query.vehicleId ? { vehicleId: query.vehicleId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      select: WORK_ORDER_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: query.limit,
    });
  }

  async createWorkOrder(access: TenantAccess, input: CreateWorkOrderInput) {
    await this.assertVehicle(access.tenantId, input.vehicleId);
    if (input.planId) {
      // The plan must belong to this tenant and to the same vehicle (planId is a plain column).
      const plan = await this.prisma.maintenancePlan.findFirst({
        where: { id: input.planId, tenantId: access.tenantId, vehicleId: input.vehicleId },
        select: { id: true },
      });
      if (!plan) throw new NotFoundException("plan_not_found");
    }
    return this.prisma.$transaction(async (tx) => {
      const wo = await tx.workOrder.create({
        data: {
          tenantId: access.tenantId,
          vehicleId: input.vehicleId,
          planId: input.planId ?? null,
          title: input.title,
          vendorName: input.vendorName ?? null,
          labourFils: input.labourFils,
          partsFils: input.partsFils,
          createdBy: access.userId,
        },
        select: WORK_ORDER_SELECT,
      });
      await this.audit.record(tx, {
        tenantId: access.tenantId,
        actorUserId: access.userId,
        entityType: "work_order",
        entityId: wo.id,
        action: "create",
        changes: { vehicleId: wo.vehicleId, planId: wo.planId, title: wo.title },
      });
      return wo;
    });
  }

  /** Separation of duties: the person who opened a work order cannot approve it. */
  async approveWorkOrder(access: TenantAccess, workOrderId: string) {
    const wo = await this.findWorkOrder(access.tenantId, workOrderId);
    if (wo.status !== "open") throw new ConflictException("invalid_transition");
    if (wo.createdBy === access.userId) throw new ForbiddenException("self_approval_forbidden");

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.workOrder.updateMany({
        where: { id: workOrderId, tenantId: access.tenantId, status: "open" },
        data: { status: "approved", approvedBy: access.userId, approvedAt: new Date() },
      });
      if (claimed.count === 0) throw new ConflictException("invalid_transition");
      await this.audit.record(tx, {
        tenantId: access.tenantId,
        actorUserId: access.userId,
        entityType: "work_order",
        entityId: workOrderId,
        action: "approve",
        changes: { status: { from: "open", to: "approved" } },
      });
      return this.findWorkOrderInTx(tx, access.tenantId, workOrderId);
    });
  }

  async cancelWorkOrder(access: TenantAccess, workOrderId: string) {
    const wo = await this.findWorkOrder(access.tenantId, workOrderId);
    if (wo.status !== "open" && wo.status !== "approved") {
      throw new ConflictException("invalid_transition");
    }
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.workOrder.updateMany({
        where: { id: workOrderId, tenantId: access.tenantId, status: { in: ["open", "approved"] } },
        data: { status: "cancelled", cancelledAt: new Date() },
      });
      if (claimed.count === 0) throw new ConflictException("invalid_transition");
      await this.audit.record(tx, {
        tenantId: access.tenantId,
        actorUserId: access.userId,
        entityType: "work_order",
        entityId: workOrderId,
        action: "cancel",
        changes: { status: { from: wo.status, to: "cancelled" } },
      });
      return this.findWorkOrderInTx(tx, access.tenantId, workOrderId);
    });
  }

  /**
   * Completes an approved work order, writes the append-only service event, and recalculates the
   * linked plan's next due odometer and date. The odometer may not fall below the vehicle's last service.
   */
  async completeWorkOrder(
    access: TenantAccess,
    workOrderId: string,
    input: CompleteWorkOrderInput,
  ) {
    const tenantId = access.tenantId;
    const wo = await this.findWorkOrder(tenantId, workOrderId);
    if (wo.status !== "approved") throw new ConflictException("invalid_transition");

    const lastService = await this.prisma.serviceEvent.findFirst({
      where: { tenantId, vehicleId: wo.vehicleId },
      orderBy: { odometer: "desc" },
      select: { odometer: true },
    });
    if (lastService && input.odometer < lastService.odometer) {
      throw new ConflictException("odometer_decreased");
    }

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.workOrder.updateMany({
        where: { id: workOrderId, tenantId, status: "approved" },
        data: {
          status: "completed",
          completedBy: access.userId,
          completedAt: new Date(),
          ...(input.labourFils !== undefined ? { labourFils: input.labourFils } : {}),
          ...(input.partsFils !== undefined ? { partsFils: input.partsFils } : {}),
          ...(input.invoiceNumber !== undefined ? { invoiceNumber: input.invoiceNumber } : {}),
        },
      });
      if (claimed.count === 0) throw new ConflictException("invalid_transition");
      const done = await tx.workOrder.findUniqueOrThrow({
        where: { id_tenantId: { id: workOrderId, tenantId } },
        select: { ...WORK_ORDER_SELECT, vendorName: true },
      });

      await tx.serviceEvent.create({
        data: {
          tenantId,
          vehicleId: done.vehicleId,
          workOrderId,
          serviceOn: input.serviceOn,
          odometer: input.odometer,
          vendorName: done.vendorName,
          labourFils: done.labourFils,
          partsFils: done.partsFils,
          invoiceNumber: done.invoiceNumber,
          recordedBy: access.userId,
        },
      });

      if (done.planId) {
        const plan = await tx.maintenancePlan.findFirst({
          where: { id: done.planId, tenantId, status: "active" },
          select: { intervalKm: true, intervalDays: true },
        });
        if (plan) {
          await tx.maintenancePlan.update({
            where: { id_tenantId: { id: done.planId, tenantId } },
            data: {
              nextDueOdometer: plan.intervalKm ? input.odometer + plan.intervalKm : null,
              nextDueDate: plan.intervalDays
                ? new Date(input.serviceOn.getTime() + plan.intervalDays * DAY_MS)
                : null,
            },
          });
        }
      }

      await this.audit.record(tx, {
        tenantId,
        actorUserId: access.userId,
        entityType: "work_order",
        entityId: workOrderId,
        action: "complete",
        changes: {
          status: { from: "approved", to: "completed" },
          odometer: input.odometer,
          serviceOn: input.serviceOn,
          totalFils: done.labourFils + done.partsFils,
        },
      });
      return done;
    });
  }

  /** Append-only service history for a vehicle, newest first. */
  async serviceHistory(tenantId: string, query: ServiceHistoryQuery) {
    await this.assertVehicle(tenantId, query.vehicleId);
    return this.prisma.serviceEvent.findMany({
      where: { tenantId, vehicleId: query.vehicleId },
      select: {
        id: true,
        workOrderId: true,
        serviceOn: true,
        odometer: true,
        vendorName: true,
        labourFils: true,
        partsFils: true,
        invoiceNumber: true,
        createdAt: true,
      },
      orderBy: [{ serviceOn: "desc" }, { id: "asc" }],
      take: query.limit,
    });
  }

  // ---- Defects and dispatch block ----------------------------------------

  async listDefects(tenantId: string, query: ListDefectsQuery) {
    return this.prisma.defect.findMany({
      where: {
        tenantId,
        ...(query.vehicleId ? { vehicleId: query.vehicleId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.severity ? { severity: query.severity } : {}),
      },
      select: DEFECT_SELECT,
      orderBy: [{ reportedAt: "desc" }, { id: "asc" }],
      take: query.limit,
    });
  }

  async reportDefect(access: TenantAccess, input: ReportDefectInput) {
    await this.assertVehicle(access.tenantId, input.vehicleId);
    return this.prisma.$transaction(async (tx) => {
      const defect = await tx.defect.create({
        data: {
          tenantId: access.tenantId,
          vehicleId: input.vehicleId,
          severity: input.severity,
          description: input.description,
          reportedBy: access.userId,
        },
        select: DEFECT_SELECT,
      });
      await this.audit.record(tx, {
        tenantId: access.tenantId,
        actorUserId: access.userId,
        entityType: "defect",
        entityId: defect.id,
        action: "report",
        changes: { vehicleId: defect.vehicleId, severity: defect.severity },
      });
      return defect;
    });
  }

  /** Clearance requires a written note; the database also enforces note and timestamp together. */
  async clearDefect(access: TenantAccess, defectId: string, input: ClearDefectInput) {
    const defect = await this.prisma.defect.findFirst({
      where: { id: defectId, tenantId: access.tenantId },
      select: { status: true, severity: true },
    });
    if (!defect) throw new NotFoundException("defect_not_found");
    if (defect.status !== "open") throw new ConflictException("defect_not_open");

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.defect.updateMany({
        where: { id: defectId, tenantId: access.tenantId, status: "open" },
        data: {
          status: "cleared",
          clearedBy: access.userId,
          clearedAt: new Date(),
          clearanceNote: input.clearanceNote,
        },
      });
      if (claimed.count === 0) throw new ConflictException("defect_not_open");
      await this.audit.record(tx, {
        tenantId: access.tenantId,
        actorUserId: access.userId,
        entityType: "defect",
        entityId: defectId,
        action: "clear",
        changes: { status: { from: "open", to: "cleared" }, severity: defect.severity },
      });
      return tx.defect.findUniqueOrThrow({
        where: { id_tenantId: { id: defectId, tenantId: access.tenantId } },
        select: DEFECT_SELECT,
      });
    });
  }

  async dispatchStatus(tenantId: string, vehicleId: string) {
    await this.assertVehicle(tenantId, vehicleId);
    const criticalDefects = await this.prisma.defect.count({
      where: { tenantId, vehicleId, status: "open", severity: "critical" },
    });
    return { vehicleId, blocked: criticalDefects > 0, criticalDefects };
  }

  /** For dispatch flows (Tasks 11–12): refuses a vehicle with an open critical defect (BR07). */
  async assertDispatchAllowed(tenantId: string, vehicleId: string): Promise<void> {
    const status = await this.dispatchStatus(tenantId, vehicleId);
    if (status.blocked) throw new ConflictException("dispatch_blocked");
  }

  // ---- helpers -----------------------------------------------------------

  private async assertVehicle(tenantId: string, vehicleId: string): Promise<void> {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, tenantId },
      select: { id: true },
    });
    if (!vehicle) throw new NotFoundException("vehicle_not_found");
  }

  private async findWorkOrder(tenantId: string, workOrderId: string) {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, tenantId },
      select: { ...WORK_ORDER_SELECT, vendorName: true },
    });
    if (!wo) throw new NotFoundException("work_order_not_found");
    return wo;
  }

  private async findWorkOrderInTx(
    tx: import("../generated/prisma/client.js").Prisma.TransactionClient,
    tenantId: string,
    workOrderId: string,
  ) {
    return tx.workOrder.findUniqueOrThrow({
      where: { id_tenantId: { id: workOrderId, tenantId } },
      select: WORK_ORDER_SELECT,
    });
  }
}
