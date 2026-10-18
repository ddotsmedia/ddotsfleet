import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { SessionGuard } from "../auth/session.guard.js";
import {
  PermissionsGuard,
  RequirePermissions,
  TenantAccessContext,
  TenantGuard,
} from "../access/access.guards.js";
import type { TenantAccess } from "../access/access.service.js";
import { parseInput } from "../common/validation.js";
import { DispatchService } from "./dispatch.service.js";
import {
  assignJobSchema,
  completeTripSchema,
  correctionSchema,
  createJobSchema,
  jobEventSchema,
  listJobsSchema,
  listReviewsSchema,
  listTripsSchema,
  openReviewSchema,
  reviewNoteSchema,
  startTripSchema,
  tripStopSchema,
} from "./dispatch.schemas.js";

const idSchema = z.uuid();

@Controller("tenants/:tenantId/trips")
@UseGuards(SessionGuard, TenantGuard, PermissionsGuard)
export class TripsController {
  constructor(private readonly dispatch: DispatchService) {}

  @Get()
  @RequirePermissions("job:read")
  async list(@TenantAccessContext() access: TenantAccess, @Query() query: Record<string, unknown>) {
    return {
      items: await this.dispatch.listTrips(access.tenantId, parseInput(listTripsSchema, query)),
    };
  }

  @Get(":tripId")
  @RequirePermissions("job:read")
  async get(@TenantAccessContext() access: TenantAccess, @Param("tripId") tripId: string) {
    return this.dispatch.getTrip(access.tenantId, parseInput(idSchema, tripId));
  }

  @Post()
  @RequirePermissions("trip:write")
  async start(@TenantAccessContext() access: TenantAccess, @Body() body: unknown) {
    return this.dispatch.startTrip(access, parseInput(startTripSchema, body));
  }

  @Post(":tripId/stops")
  @RequirePermissions("trip:write")
  async stop(
    @TenantAccessContext() access: TenantAccess,
    @Param("tripId") tripId: string,
    @Body() body: unknown,
  ) {
    return this.dispatch.recordTripStop(
      access,
      parseInput(idSchema, tripId),
      parseInput(tripStopSchema, body),
    );
  }

  @Post(":tripId/complete")
  @RequirePermissions("trip:write")
  async complete(
    @TenantAccessContext() access: TenantAccess,
    @Param("tripId") tripId: string,
    @Body() body: unknown,
  ) {
    return this.dispatch.completeTrip(
      access,
      parseInput(idSchema, tripId),
      parseInput(completeTripSchema, body),
    );
  }
}

@Controller("tenants/:tenantId/dispatch/jobs")
@UseGuards(SessionGuard, TenantGuard, PermissionsGuard)
export class JobsController {
  constructor(private readonly dispatch: DispatchService) {}

  @Get()
  @RequirePermissions("job:read")
  async list(@TenantAccessContext() access: TenantAccess, @Query() query: Record<string, unknown>) {
    return {
      items: await this.dispatch.listJobs(access.tenantId, parseInput(listJobsSchema, query)),
    };
  }

  @Post()
  @RequirePermissions("job:write")
  async create(@TenantAccessContext() access: TenantAccess, @Body() body: unknown) {
    return this.dispatch.createJob(access, parseInput(createJobSchema, body));
  }

  @Post(":jobId/assign")
  @RequirePermissions("job:write")
  async assign(
    @TenantAccessContext() access: TenantAccess,
    @Param("jobId") jobId: string,
    @Body() body: unknown,
  ) {
    return this.dispatch.assignJob(
      access,
      parseInput(idSchema, jobId),
      parseInput(assignJobSchema, body),
    );
  }

  /** Drivers report progress through trip:write; the service limits them to jobs assigned to them. */
  @Post(":jobId/events")
  @RequirePermissions("trip:write")
  async event(
    @TenantAccessContext() access: TenantAccess,
    @Param("jobId") jobId: string,
    @Body() body: unknown,
  ) {
    return this.dispatch.recordJobEvent(
      access,
      parseInput(idSchema, jobId),
      parseInput(jobEventSchema, body),
    );
  }
}

@Controller("tenants/:tenantId/reviews")
@UseGuards(SessionGuard, TenantGuard, PermissionsGuard)
export class ReviewsController {
  constructor(private readonly dispatch: DispatchService) {}

  @Get()
  @RequirePermissions("job:read")
  async list(@TenantAccessContext() access: TenantAccess, @Query() query: Record<string, unknown>) {
    return {
      items: await this.dispatch.listReviews(access.tenantId, parseInput(listReviewsSchema, query)),
    };
  }

  @Post()
  @RequirePermissions("trip:write")
  async open(@TenantAccessContext() access: TenantAccess, @Body() body: unknown) {
    return this.dispatch.openReview(access, parseInput(openReviewSchema, body));
  }

  @Post(":reviewId/submit")
  @RequirePermissions("trip:write")
  async submit(
    @TenantAccessContext() access: TenantAccess,
    @Param("reviewId") reviewId: string,
    @Body() body: unknown,
  ) {
    return this.dispatch.submitReview(
      access,
      parseInput(idSchema, reviewId),
      parseInput(reviewNoteSchema, body ?? {}),
    );
  }

  @Post(":reviewId/approve")
  @RequirePermissions("approval:review")
  async approve(
    @TenantAccessContext() access: TenantAccess,
    @Param("reviewId") reviewId: string,
    @Body() body: unknown,
  ) {
    return this.dispatch.approveReview(
      access,
      parseInput(idSchema, reviewId),
      parseInput(reviewNoteSchema, body ?? {}),
    );
  }

  @Post(":reviewId/request-correction")
  @RequirePermissions("approval:review")
  async correct(
    @TenantAccessContext() access: TenantAccess,
    @Param("reviewId") reviewId: string,
    @Body() body: unknown,
  ) {
    return this.dispatch.requestCorrection(
      access,
      parseInput(idSchema, reviewId),
      parseInput(correctionSchema, body),
    );
  }

  @Post(":reviewId/close")
  @RequirePermissions("approval:review")
  async close(
    @TenantAccessContext() access: TenantAccess,
    @Param("reviewId") reviewId: string,
    @Body() body: unknown,
  ) {
    return this.dispatch.closeReview(
      access,
      parseInput(idSchema, reviewId),
      parseInput(reviewNoteSchema, body ?? {}),
    );
  }
}
