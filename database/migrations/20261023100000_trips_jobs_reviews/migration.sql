-- CreateEnum
CREATE TYPE "TripStatus" AS ENUM ('open', 'completed');
CREATE TYPE "TripStopType" AS ENUM ('arrived', 'departed', 'note');
CREATE TYPE "DispatchPriority" AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TYPE "JobStatus" AS ENUM ('planned', 'assigned', 'in_progress', 'completed', 'cancelled');
CREATE TYPE "JobEventType" AS ENUM ('assigned', 'started', 'arrived', 'delivered', 'note', 'completed', 'cancelled');
CREATE TYPE "ReviewState" AS ENUM ('draft', 'submitted', 'correction_requested', 'approved', 'closed');

-- CreateTable
CREATE TABLE "trips" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "shift_id" UUID,
    "checkout_id" UUID,
    "job_id" UUID,
    "status" "TripStatus" NOT NULL DEFAULT 'open',
    "purpose" TEXT NOT NULL,
    "origin_declared" TEXT NOT NULL,
    "destination_declared" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "start_odometer" INTEGER NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "end_odometer" INTEGER,
    "started_by" UUID,
    "ended_by" UUID,
    "client_ref" TEXT,
    "operation_date" DATE NOT NULL,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_stops" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "stop_order" INTEGER NOT NULL,
    "event_type" "TripStopType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID,
    "client_ref" TEXT,
    "note" TEXT,
    "odometer" INTEGER,

    CONSTRAINT "trip_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "priority" "DispatchPriority" NOT NULL DEFAULT 'normal',
    "status" "JobStatus" NOT NULL DEFAULT 'planned',
    "planned_start" TIMESTAMPTZ(6),
    "planned_end" TIMESTAMPTZ(6),
    "vehicle_id" UUID,
    "driver_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "dispatch_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "event_type" "JobEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID,
    "client_ref" TEXT,
    "note" TEXT,

    CONSTRAINT "job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_reviews" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "operation_date" DATE NOT NULL,
    "state" "ReviewState" NOT NULL DEFAULT 'draft',
    "submitted_by" UUID,
    "submitted_at" TIMESTAMPTZ(6),
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "daily_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "from_state" "ReviewState",
    "to_state" "ReviewState" NOT NULL,
    "actor_user_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "review_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trips_id_tenant_id_key" ON "trips"("id", "tenant_id");
CREATE UNIQUE INDEX "trips_tenant_id_client_ref_key" ON "trips"("tenant_id", "client_ref");
CREATE INDEX "trips_tenant_id_vehicle_id_operation_date_idx" ON "trips"("tenant_id", "vehicle_id", "operation_date");
CREATE INDEX "trips_tenant_id_driver_id_started_at_idx" ON "trips"("tenant_id", "driver_id", "started_at");
CREATE UNIQUE INDEX "trip_stops_trip_id_stop_order_key" ON "trip_stops"("trip_id", "stop_order");
CREATE UNIQUE INDEX "trip_stops_tenant_id_client_ref_key" ON "trip_stops"("tenant_id", "client_ref");
CREATE UNIQUE INDEX "dispatch_jobs_id_tenant_id_key" ON "dispatch_jobs"("id", "tenant_id");
CREATE UNIQUE INDEX "dispatch_jobs_tenant_id_reference_key" ON "dispatch_jobs"("tenant_id", "reference");
CREATE INDEX "dispatch_jobs_tenant_id_status_idx" ON "dispatch_jobs"("tenant_id", "status");
CREATE UNIQUE INDEX "job_events_tenant_id_client_ref_key" ON "job_events"("tenant_id", "client_ref");
CREATE INDEX "job_events_job_id_occurred_at_idx" ON "job_events"("job_id", "occurred_at");
CREATE UNIQUE INDEX "daily_reviews_id_tenant_id_key" ON "daily_reviews"("id", "tenant_id");
CREATE UNIQUE INDEX "daily_reviews_tenant_id_vehicle_id_operation_date_key" ON "daily_reviews"("tenant_id", "vehicle_id", "operation_date");
CREATE INDEX "review_events_review_id_occurred_at_idx" ON "review_events"("review_id", "occurred_at");

-- Partial unique indexes (not modelled by Prisma): one open trip per vehicle and per driver.
CREATE UNIQUE INDEX "trips_one_open_per_vehicle" ON "trips"("vehicle_id") WHERE "status" = 'open';
CREATE UNIQUE INDEX "trips_one_open_per_driver" ON "trips"("driver_id") WHERE "status" = 'open';

-- Check constraints
ALTER TABLE "trips" ADD CONSTRAINT "trips_state_check" CHECK (
    ("status" = 'open' AND "ended_at" IS NULL AND "end_odometer" IS NULL)
    OR ("status" = 'completed' AND "ended_at" IS NOT NULL AND "end_odometer" IS NOT NULL)
);
ALTER TABLE "trips" ADD CONSTRAINT "trips_odometer_check" CHECK ("end_odometer" IS NULL OR "end_odometer" >= "start_odometer");
ALTER TABLE "trips" ADD CONSTRAINT "trips_period_check" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");
ALTER TABLE "dispatch_jobs" ADD CONSTRAINT "dispatch_jobs_assignment_check" CHECK (
    "status" NOT IN ('assigned', 'in_progress') OR ("vehicle_id" IS NOT NULL AND "driver_id" IS NOT NULL)
);
ALTER TABLE "dispatch_jobs" ADD CONSTRAINT "dispatch_jobs_state_check" CHECK (
    ("status" <> 'completed' OR "completed_at" IS NOT NULL)
    AND ("status" <> 'cancelled' OR "cancelled_at" IS NOT NULL)
);

-- AddForeignKey (tenant-aware composite keys)
ALTER TABLE "trips" ADD CONSTRAINT "trips_vehicle_id_tenant_id_fkey" FOREIGN KEY ("vehicle_id", "tenant_id") REFERENCES "vehicles"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trips" ADD CONSTRAINT "trips_driver_id_tenant_id_fkey" FOREIGN KEY ("driver_id", "tenant_id") REFERENCES "drivers"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trip_stops" ADD CONSTRAINT "trip_stops_trip_id_tenant_id_fkey" FOREIGN KEY ("trip_id", "tenant_id") REFERENCES "trips"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dispatch_jobs" ADD CONSTRAINT "dispatch_jobs_vehicle_id_tenant_id_fkey" FOREIGN KEY ("vehicle_id", "tenant_id") REFERENCES "vehicles"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dispatch_jobs" ADD CONSTRAINT "dispatch_jobs_driver_id_tenant_id_fkey" FOREIGN KEY ("driver_id", "tenant_id") REFERENCES "drivers"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_tenant_id_fkey" FOREIGN KEY ("job_id", "tenant_id") REFERENCES "dispatch_jobs"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "daily_reviews" ADD CONSTRAINT "daily_reviews_vehicle_id_tenant_id_fkey" FOREIGN KEY ("vehicle_id", "tenant_id") REFERENCES "vehicles"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_review_id_tenant_id_fkey" FOREIGN KEY ("review_id", "tenant_id") REFERENCES "daily_reviews"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only history: stops, job events and review events are never edited or deleted (BR06, BR09).
CREATE OR REPLACE FUNCTION "append_only_reject_change"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trip_stops_append_only"
    BEFORE UPDATE OR DELETE ON "trip_stops"
    FOR EACH ROW EXECUTE FUNCTION "append_only_reject_change"();
CREATE TRIGGER "job_events_append_only"
    BEFORE UPDATE OR DELETE ON "job_events"
    FOR EACH ROW EXECUTE FUNCTION "append_only_reject_change"();
CREATE TRIGGER "review_events_append_only"
    BEFORE UPDATE OR DELETE ON "review_events"
    FOR EACH ROW EXECUTE FUNCTION "append_only_reject_change"();
