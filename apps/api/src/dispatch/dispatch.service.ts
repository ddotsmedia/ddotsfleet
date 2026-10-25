import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { JobStatus, Prisma, ReviewState } from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { assertActsForDriver, loadActiveDriver } from "../access/driver-scope.js";
import type { TenantAccess } from "../access/access.service.js";
import { MaintenanceService } from "../maintenance/maintenance.service.js";
import type {
  AssignJobInput,
  CompleteTripInput,
  CorrectionInput,
  CreateJobInput,
  JobEventInput,
  ListJobsQuery,
  ListReviewsQuery,
  ListTripsQuery,
  OpenReviewInput,
  ReviewNoteInput,
  StartTripInput,
  TripStopInput,
} from "./dispatch.schemas.js";

const FUTURE_SKEW_MS = 5 * 60_000;
const DUBAI = "Asia/Dubai";

const TRIP_SELECT = {
  id: true,
  vehicleId: true,
  driverId: true,
  shiftId: true,
  checkoutId: true,
  jobId: true,
  status: true,
  purpose: true,
  originDeclared: true,
  destinationDeclared: true,
  startedAt: true,
  startOdometer: true,
  endedAt: true,
  endOdometer: true,
  operationDate: true,
  clientRef: true,
} as const;

const STOP_SELECT = {
  id: true,
  tripId: true,
  stopOrder: true,
  eventType: true,
  occurredAt: true,
  odometer: true,
  note: true,
  clientRef: true,
} as const;

const JOB_SELECT = {
  id: true,
  reference: true,
  customerName: true,
  priority: true,
  status: true,
  plannedStart: true,
  plannedEnd: true,
  vehicleId: true,
  driverId: true,
  createdAt: true,
  completedAt: true,
  cancelledAt: true,
} as const;

const REVIEW_SELECT = {
  id: true,
  vehicleId: true,
  operationDate: true,
  state: true,
  submittedAt: true,
  decidedAt: true,
} as const;

/** Job state after each progress event: the required "from" states and the resulting state. */
const JOB_TRANSITIONS: Record<
  JobEventInput["eventType"],
  { from: string[]; to?: "in_progress" | "completed" | "cancelled" }
> = {
  started: { from: ["assigned"], to: "in_progress" },
  arrived: { from: ["in_progress"] },
  delivered: { from: ["in_progress"] },
  note: { from: ["in_progress"] },
  completed: { from: ["in_progress"], to: "completed" },
  cancelled: { from: ["planned", "assigned"], to: "cancelled" },
};

/** Dubai has no DST, so the operation date is the calendar date in +04:00. */
export function dubaiOperationDate(at: Date): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: DUBAI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return new Date(`${ymd}T00:00:00.000Z`);
}

@Injectable()
export class DispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly maintenance: MaintenanceService,
  ) {}

  // ---- trips -------------------------------------------------------------

  async listTrips(tenantId: string, query: ListTripsQuery) {
    return this.prisma.trip.findMany({
      where: {
        tenantId,
        vehicleId: query.vehicleId,
        driverId: query.driverId,
        status: query.status,
        operationDate: query.date ? new Date(`${query.date}T00:00:00.000Z`) : undefined,
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: query.limit,
      select: TRIP_SELECT,
    });
  }

  async getTrip(tenantId: string, tripId: string) {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, tenantId },
      select: { ...TRIP_SELECT, stops: { orderBy: { stopOrder: "asc" }, select: STOP_SELECT } },
    });
    if (!trip) throw new NotFoundException("trip_not_found");
    return trip;
  }

  /**
   * Departure requires an open vehicle checkout by the same driver (SRS: checkout and safety check
   * before departure), no critical defect (BR07), and an odometer that does not decrease (BR05).
   */
  async startTrip(access: TenantAccess, input: StartTripInput) {
    const tenantId = access.tenantId;
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: input.vehicleId, tenantId },
      select: { status: true },
    });
    if (!vehicle) throw new NotFoundException("vehicle_not_found");
    if (vehicle.status !== "active") throw new ConflictException("vehicle_not_available");
    await this.maintenance.assertDispatchAllowed(tenantId, input.vehicleId);

    await loadActiveDriver(this.prisma, tenantId, input.driverId);
    await assertActsForDriver(this.prisma, access, input.driverId);

    const now = Date.now();
    const startedAt = input.startedAt ? new Date(input.startedAt) : new Date(now);
    if (startedAt.getTime() > now + FUTURE_SKEW_MS) throw new BadRequestException("time_in_future");

    const checkout = await this.prisma.vehicleCheckout.findFirst({
      where: { tenantId, vehicleId: input.vehicleId, driverId: input.driverId, status: "open" },
      select: { id: true, openingOdometer: true },
    });
    if (!checkout) throw new ConflictException("checkout_required");

    if (input.shiftId) {
      const shift = await this.prisma.driverShift.findFirst({
        where: { id: input.shiftId, tenantId },
        select: { driverId: true, status: true },
      });
      if (!shift) throw new NotFoundException("shift_not_found");
      if (shift.driverId !== input.driverId) throw new ConflictException("shift_driver_mismatch");
      if (shift.status !== "open") throw new ConflictException("shift_not_open");
    }

    if (input.jobId) {
      const job = await this.prisma.dispatchJob.findFirst({
        where: { id: input.jobId, tenantId },
        select: { status: true, vehicleId: true, driverId: true },
      });
      if (!job) throw new NotFoundException("job_not_found");
      const assigned = job.vehicleId === input.vehicleId && job.driverId === input.driverId;
      if (!assigned || !["assigned", "in_progress"].includes(job.status)) {
        throw new ConflictException("job_not_assignable");
      }
    }

    const [openTrip, lastEnded] = await Promise.all([
      this.prisma.trip.findFirst({
        where: {
          tenantId,
          status: "open",
          OR: [{ vehicleId: input.vehicleId }, { driverId: input.driverId }],
        },
        select: { id: true },
      }),
      this.prisma.trip.findFirst({
        where: { tenantId, vehicleId: input.vehicleId, status: "completed" },
        orderBy: { endOdometer: "desc" },
        select: { endOdometer: true },
      }),
    ]);
    if (openTrip) throw new ConflictException("trip_already_open");
    const floor = Math.max(checkout.openingOdometer, lastEnded?.endOdometer ?? 0);
    if (input.startOdometer < floor) throw new ConflictException("odometer_decreased");

    try {
      return await this.prisma.$transaction(async (tx) => {
        const trip = await tx.trip.create({
          data: {
            tenantId,
            vehicleId: input.vehicleId,
            driverId: input.driverId,
            shiftId: input.shiftId ?? null,
            checkoutId: checkout.id,
            jobId: input.jobId ?? null,
            purpose: input.purpose,
            originDeclared: input.originDeclared,
            destinationDeclared: input.destinationDeclared,
            startedAt,
            startOdometer: input.startOdometer,
            startedBy: access.userId,
            clientRef: input.clientRef ?? null,
            operationDate: dubaiOperationDate(startedAt),
          },
          select: TRIP_SELECT,
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: "trip",
          entityId: trip.id,
          action: "start",
          changes: {
            vehicleId: { to: input.vehicleId },
            driverId: { to: input.driverId },
            startOdometer: { to: input.startOdometer },
          },
        });
        return trip;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  /** Declared stops are driver-entered, so they are labelled as declarations, never GPS-confirmed (BR08). */
  async recordTripStop(access: TenantAccess, tripId: string, input: TripStopInput) {
    const tenantId = access.tenantId;
    if (input.clientRef) {
      const dup = await this.prisma.tripStop.findFirst({
        where: { tenantId, clientRef: input.clientRef },
        select: STOP_SELECT,
      });
      if (dup) {
        if (dup.tripId !== tripId) throw new ConflictException("client_ref_conflict");
        return dup;
      }
    }

    const trip = await this.loadTrip(tenantId, tripId);
    await assertActsForDriver(this.prisma, access, trip.driverId);
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (occurredAt.getTime() > Date.now() + FUTURE_SKEW_MS) {
      throw new BadRequestException("time_in_future");
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockRow(tx, "trips", tripId, tenantId);
        const current = await tx.trip.findFirst({
          where: { id: tripId, tenantId },
          select: { status: true, startedAt: true, startOdometer: true },
        });
        if (!current || current.status !== "open") throw new ConflictException("trip_not_open");
        if (occurredAt < current.startedAt) throw new BadRequestException("event_before_trip");

        const last = await tx.tripStop.findFirst({
          where: { tripId },
          orderBy: { stopOrder: "desc" },
          select: { stopOrder: true, occurredAt: true, odometer: true },
        });
        if (last && occurredAt < last.occurredAt) throw new ConflictException("event_out_of_order");
        const odometerFloor = Math.max(current.startOdometer, last?.odometer ?? 0);
        if (input.odometer !== undefined && input.odometer < odometerFloor) {
          throw new ConflictException("odometer_decreased");
        }

        const stop = await tx.tripStop.create({
          data: {
            tenantId,
            tripId,
            stopOrder: (last?.stopOrder ?? 0) + 1,
            eventType: input.eventType,
            occurredAt,
            recordedBy: access.userId,
            clientRef: input.clientRef ?? null,
            note: input.note ?? null,
            odometer: input.odometer ?? null,
          },
          select: STOP_SELECT,
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: "trip",
          entityId: tripId,
          action: `stop_${input.eventType}`,
          changes: { stopOrder: { to: stop.stopOrder } },
        });
        return stop;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  async completeTrip(access: TenantAccess, tripId: string, input: CompleteTripInput) {
    const tenantId = access.tenantId;
    if (input.clientRef) {
      // Offline retry of a completion that already succeeded returns the closed trip.
      const dup = await this.prisma.trip.findFirst({
        where: { tenantId, endClientRef: input.clientRef },
        select: TRIP_SELECT,
      });
      if (dup) {
        if (dup.id !== tripId) throw new ConflictException("client_ref_conflict");
        return dup;
      }
    }
    const trip = await this.loadTrip(tenantId, tripId);
    await assertActsForDriver(this.prisma, access, trip.driverId);
    const endedAt = input.endedAt ? new Date(input.endedAt) : new Date();
    if (endedAt.getTime() > Date.now() + FUTURE_SKEW_MS)
      throw new BadRequestException("time_in_future");

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockRow(tx, "trips", tripId, tenantId);
        const current = await tx.trip.findFirst({
          where: { id: tripId, tenantId },
          select: { status: true, startedAt: true, startOdometer: true },
        });
        if (!current || current.status !== "open") throw new ConflictException("trip_not_open");
        if (endedAt < current.startedAt) throw new BadRequestException("invalid_period");

        const last = await tx.tripStop.findFirst({
          where: { tripId },
          orderBy: { stopOrder: "desc" },
          select: { occurredAt: true, odometer: true },
        });
        if (last && endedAt < last.occurredAt) throw new ConflictException("event_out_of_order");
        const floor = Math.max(current.startOdometer, last?.odometer ?? 0);
        if (input.endOdometer < floor) throw new ConflictException("odometer_decreased");

        const updated = await tx.trip.update({
          where: { id_tenantId: { id: tripId, tenantId } },
          data: {
            status: "completed",
            endedAt,
            endOdometer: input.endOdometer,
            endedBy: access.userId,
            endClientRef: input.clientRef ?? null,
          },
          select: TRIP_SELECT,
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: "trip",
          entityId: tripId,
          action: "complete",
          changes: { endOdometer: { to: input.endOdometer } },
        });
        return updated;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  // ---- dispatch jobs -----------------------------------------------------

  async listJobs(tenantId: string, query: ListJobsQuery) {
    return this.prisma.dispatchJob.findMany({
      where: { tenantId, status: query.status },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit,
      select: JOB_SELECT,
    });
  }

  async createJob(access: TenantAccess, input: CreateJobInput) {
    const tenantId = access.tenantId;
    const clash = await this.prisma.dispatchJob.findFirst({
      where: { tenantId, reference: input.reference },
      select: { id: true },
    });
    if (clash) throw new ConflictException("job_reference_exists");

    try {
      return await this.prisma.$transaction(async (tx) => {
        const job = await tx.dispatchJob.create({
          data: {
            tenantId,
            reference: input.reference,
            customerName: input.customerName,
            priority: input.priority,
            plannedStart: input.plannedStart ? new Date(input.plannedStart) : null,
            plannedEnd: input.plannedEnd ? new Date(input.plannedEnd) : null,
            createdBy: access.userId,
          },
          select: JOB_SELECT,
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: "dispatch_job",
          entityId: job.id,
          action: "create",
          changes: { reference: { to: input.reference }, priority: { to: input.priority } },
        });
        return job;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  /** Assigns (or re-assigns) a planned or assigned job to a vehicle and an active driver. */
  async assignJob(access: TenantAccess, jobId: string, input: AssignJobInput) {
    const tenantId = access.tenantId;
    const job = await this.prisma.dispatchJob.findFirst({
      where: { id: jobId, tenantId },
      select: { status: true },
    });
    if (!job) throw new NotFoundException("job_not_found");
    if (!["planned", "assigned"].includes(job.status))
      throw new ConflictException("invalid_transition");

    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: input.vehicleId, tenantId },
      select: { status: true },
    });
    if (!vehicle) throw new NotFoundException("vehicle_not_found");
    if (vehicle.status !== "active") throw new ConflictException("vehicle_not_available");
    await loadActiveDriver(this.prisma, tenantId, input.driverId);

    return this.prisma.$transaction(async (tx) => {
      await this.lockRow(tx, "dispatch_jobs", jobId, tenantId);
      const moved = await tx.dispatchJob.updateMany({
        where: { id: jobId, tenantId, status: { in: ["planned", "assigned"] } },
        data: { status: "assigned", vehicleId: input.vehicleId, driverId: input.driverId },
      });
      if (moved.count === 0) throw new ConflictException("invalid_transition");
      const event = await tx.jobEvent.create({
        data: {
          tenantId,
          jobId,
          eventType: "assigned",
          occurredAt: new Date(),
          recordedBy: access.userId,
          note: null,
        },
      });
      await this.audit.record(tx, {
        tenantId,
        actorUserId: access.userId,
        entityType: "dispatch_job",
        entityId: jobId,
        action: "assign",
        changes: {
          vehicleId: { to: input.vehicleId },
          driverId: { to: input.driverId },
          eventId: { to: event.id },
        },
      });
      return tx.dispatchJob.findUniqueOrThrow({
        where: { id_tenantId: { id: jobId, tenantId } },
        select: JOB_SELECT,
      });
    });
  }

  /**
   * Progress events are append-only. Status changes are guarded by the from-state, so a stale
   * retry cannot move a job twice. Office staff (job:write) may act on any job; drivers only on
   * jobs assigned to their own linked driver record.
   */
  async recordJobEvent(access: TenantAccess, jobId: string, input: JobEventInput) {
    const tenantId = access.tenantId;
    if (input.clientRef) {
      const dup = await this.prisma.jobEvent.findFirst({
        where: { tenantId, clientRef: input.clientRef },
        select: {
          id: true,
          jobId: true,
          eventType: true,
          occurredAt: true,
          note: true,
          clientRef: true,
        },
      });
      if (dup) {
        if (dup.jobId !== jobId) throw new ConflictException("client_ref_conflict");
        return dup;
      }
    }

    const job = await this.prisma.dispatchJob.findFirst({
      where: { id: jobId, tenantId },
      select: { status: true, driverId: true },
    });
    if (!job) throw new NotFoundException("job_not_found");
    if (!access.permissions.has("job:write")) {
      await assertActsForDriver(this.prisma, access, job.driverId);
    }

    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (occurredAt.getTime() > Date.now() + FUTURE_SKEW_MS)
      throw new BadRequestException("time_in_future");
    const transition = JOB_TRANSITIONS[input.eventType];

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockRow(tx, "dispatch_jobs", jobId, tenantId);
        const current = await tx.dispatchJob.findFirst({
          where: { id: jobId, tenantId },
          select: { status: true },
        });
        if (!current || !transition.from.includes(current.status)) {
          throw new ConflictException("invalid_transition");
        }

        if (transition.to) {
          const moved = await tx.dispatchJob.updateMany({
            where: { id: jobId, tenantId, status: { in: transition.from as JobStatus[] } },
            data: {
              status: transition.to,
              ...(transition.to === "completed" ? { completedAt: occurredAt } : {}),
              ...(transition.to === "cancelled" ? { cancelledAt: occurredAt } : {}),
            },
          });
          if (moved.count === 0) throw new ConflictException("invalid_transition");
        }

        const event = await tx.jobEvent.create({
          data: {
            tenantId,
            jobId,
            eventType: input.eventType,
            occurredAt,
            recordedBy: access.userId,
            clientRef: input.clientRef ?? null,
            note: input.note ?? null,
          },
          select: {
            id: true,
            jobId: true,
            eventType: true,
            occurredAt: true,
            note: true,
            clientRef: true,
          },
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: "dispatch_job",
          entityId: jobId,
          action: `event_${input.eventType}`,
          changes: { eventId: { to: event.id } },
        });
        return event;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  // ---- daily reviews -----------------------------------------------------

  async listReviews(tenantId: string, query: ListReviewsQuery) {
    return this.prisma.dailyReview.findMany({
      where: {
        tenantId,
        vehicleId: query.vehicleId,
        state: query.state,
        operationDate: query.date ? new Date(`${query.date}T00:00:00.000Z`) : undefined,
      },
      orderBy: [{ operationDate: "desc" }, { id: "desc" }],
      take: query.limit,
      select: REVIEW_SELECT,
    });
  }

  /** Gets or creates the draft review for a vehicle on an operation date. Idempotent. */
  async openReview(access: TenantAccess, input: OpenReviewInput) {
    const tenantId = access.tenantId;
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: input.vehicleId, tenantId },
      select: { id: true },
    });
    if (!vehicle) throw new NotFoundException("vehicle_not_found");
    const operationDate = new Date(`${input.operationDate}T00:00:00.000Z`);

    const existing = await this.prisma.dailyReview.findFirst({
      where: { tenantId, vehicleId: input.vehicleId, operationDate },
      select: REVIEW_SELECT,
    });
    if (existing) return existing;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const review = await tx.dailyReview.create({
          data: { tenantId, vehicleId: input.vehicleId, operationDate },
          select: REVIEW_SELECT,
        });
        await tx.reviewEvent.create({
          data: {
            tenantId,
            reviewId: review.id,
            fromState: null,
            toState: "draft",
            actorUserId: access.userId,
          },
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: "daily_review",
          entityId: review.id,
          action: "open",
          changes: {
            vehicleId: { to: input.vehicleId },
            operationDate: { to: input.operationDate },
          },
        });
        return review;
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  /** Submission is refused while the vehicle still has an open trip that day. */
  async submitReview(access: TenantAccess, reviewId: string, input: ReviewNoteInput) {
    const review = await this.loadReview(access.tenantId, reviewId);
    const open = await this.prisma.trip.count({
      where: {
        tenantId: access.tenantId,
        vehicleId: review.vehicleId,
        operationDate: review.operationDate,
        status: "open",
      },
    });
    if (open > 0) throw new ConflictException("open_trips_remaining");
    return this.transitionReview(
      access,
      reviewId,
      ["draft", "correction_requested"],
      "submitted",
      input.note,
      {
        submittedBy: access.userId,
        submittedAt: new Date(),
      },
    );
  }

  /** Reviewers may not decide on a day they submitted themselves (separation of duties). */
  async approveReview(access: TenantAccess, reviewId: string, input: ReviewNoteInput) {
    await this.assertNotSubmitter(access, reviewId);
    return this.transitionReview(access, reviewId, ["submitted"], "approved", input.note, {
      decidedBy: access.userId,
      decidedAt: new Date(),
    });
  }

  async requestCorrection(access: TenantAccess, reviewId: string, input: CorrectionInput) {
    await this.assertNotSubmitter(access, reviewId);
    return this.transitionReview(
      access,
      reviewId,
      ["submitted"],
      "correction_requested",
      input.note,
      {
        decidedBy: access.userId,
        decidedAt: new Date(),
      },
    );
  }

  async closeReview(access: TenantAccess, reviewId: string, input: ReviewNoteInput) {
    return this.transitionReview(access, reviewId, ["approved"], "closed", input.note);
  }

  // ---- helpers -----------------------------------------------------------

  private async loadTrip(tenantId: string, tripId: string) {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, tenantId },
      select: { driverId: true },
    });
    if (!trip) throw new NotFoundException("trip_not_found");
    return trip;
  }

  private async loadReview(tenantId: string, reviewId: string) {
    const review = await this.prisma.dailyReview.findFirst({
      where: { id: reviewId, tenantId },
      select: { id: true, vehicleId: true, operationDate: true, submittedBy: true, state: true },
    });
    if (!review) throw new NotFoundException("review_not_found");
    return review;
  }

  private async assertNotSubmitter(access: TenantAccess, reviewId: string): Promise<void> {
    const review = await this.loadReview(access.tenantId, reviewId);
    if (review.submittedBy === access.userId)
      throw new ForbiddenException("self_approval_forbidden");
  }

  /** Status moves are guarded by the from-state inside the transaction, with the event and audit in the same write. */
  private async transitionReview(
    access: TenantAccess,
    reviewId: string,
    from: ReviewState[],
    to: ReviewState,
    note: string | undefined,
    extra: Record<string, unknown> = {},
  ) {
    const tenantId = access.tenantId;
    await this.loadReview(tenantId, reviewId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockRow(tx, "daily_reviews", reviewId, tenantId);
        const current = await tx.dailyReview.findFirst({
          where: { id: reviewId, tenantId },
          select: { state: true },
        });
        if (!current || !from.includes(current.state))
          throw new ConflictException("invalid_transition");

        const moved = await tx.dailyReview.updateMany({
          where: { id: reviewId, tenantId, state: { in: from } },
          data: { state: to, ...extra },
        });
        if (moved.count === 0) throw new ConflictException("invalid_transition");

        await tx.reviewEvent.create({
          data: {
            tenantId,
            reviewId,
            fromState: current.state,
            toState: to,
            actorUserId: access.userId,
            note: note ?? null,
          },
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: access.userId,
          entityType: "daily_review",
          entityId: reviewId,
          action: to,
          changes: { state: { from: current.state, to } },
        });
        return tx.dailyReview.findUniqueOrThrow({
          where: { id_tenantId: { id: reviewId, tenantId } },
          select: REVIEW_SELECT,
        });
      });
    } catch (e) {
      throw this.mapConflict(e);
    }
  }

  /** Row locks for read-check-write sequences. One tagged query per table; no identifiers are interpolated. */
  private async lockRow(
    tx: Prisma.TransactionClient,
    table: "trips" | "dispatch_jobs" | "daily_reviews",
    id: string,
    tenantId: string,
  ): Promise<void> {
    if (table === "trips") {
      await tx.$queryRaw`SELECT id FROM trips WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
    } else if (table === "dispatch_jobs") {
      await tx.$queryRaw`SELECT id FROM dispatch_jobs WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
    } else {
      await tx.$queryRaw`SELECT id FROM daily_reviews WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
    }
  }

  private mapConflict(e: unknown): unknown {
    if ((e as { code?: string }).code !== "P2002") return e;
    return new ConflictException("conflict");
  }
}
