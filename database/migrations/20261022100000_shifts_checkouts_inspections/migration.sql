-- AlterTable: link a driver record to the tenant user who drives (nullable; one driver per user per tenant)
ALTER TABLE "drivers" ADD COLUMN "linked_user_id" UUID;

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "ShiftEventType" AS ENUM ('break_start', 'break_end');

-- CreateEnum
CREATE TYPE "CheckoutStatus" AS ENUM ('open', 'returned');

-- CreateEnum
CREATE TYPE "InspectionKind" AS ENUM ('pre_trip', 'post_trip');

-- CreateEnum
CREATE TYPE "InspectionAnswer" AS ENUM ('pass', 'fail', 'na');

-- CreateTable
CREATE TABLE "driver_shifts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'open',
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "started_by" UUID,
    "ended_by" UUID,

    CONSTRAINT "driver_shifts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "driver_shifts_state_check" CHECK (
        ("status" = 'open' AND "ended_at" IS NULL)
        OR ("status" = 'closed' AND "ended_at" IS NOT NULL AND "ended_at" >= "started_at")
    )
);

-- CreateTable
CREATE TABLE "shift_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "event_type" "ShiftEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID,
    "client_ref" TEXT,

    CONSTRAINT "shift_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_checkouts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "shift_id" UUID,
    "status" "CheckoutStatus" NOT NULL DEFAULT 'open',
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "opening_odometer" INTEGER NOT NULL,
    "opening_fuel_percent" INTEGER NOT NULL,
    "opening_damage_notes" TEXT,
    "opened_by" UUID,
    "returned_at" TIMESTAMPTZ(6),
    "closing_odometer" INTEGER,
    "closing_fuel_percent" INTEGER,
    "closing_damage_notes" TEXT,
    "returned_by" UUID,

    CONSTRAINT "vehicle_checkouts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "vehicle_checkouts_fuel_check" CHECK (
        "opening_fuel_percent" BETWEEN 0 AND 100
        AND ("closing_fuel_percent" IS NULL OR "closing_fuel_percent" BETWEEN 0 AND 100)
    ),
    CONSTRAINT "vehicle_checkouts_state_check" CHECK (
        ("status" = 'open' AND "returned_at" IS NULL AND "closing_odometer" IS NULL AND "closing_fuel_percent" IS NULL)
        OR ("status" = 'returned' AND "returned_at" IS NOT NULL AND "closing_odometer" IS NOT NULL AND "closing_fuel_percent" IS NOT NULL)
    ),
    -- Odometer may not fall during a checkout (BR05).
    CONSTRAINT "vehicle_checkouts_odometer_check" CHECK (
        "closing_odometer" IS NULL OR "closing_odometer" >= "opening_odometer"
    )
);

-- CreateTable
CREATE TABLE "inspections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "checkout_id" UUID,
    "kind" "InspectionKind" NOT NULL,
    "result" "InspectionAnswer" NOT NULL,
    "performed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performed_by" UUID,
    "client_ref" TEXT,

    CONSTRAINT "inspections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inspections_result_check" CHECK ("result" IN ('pass', 'fail'))
);

-- CreateTable
CREATE TABLE "inspection_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "answer" "InspectionAnswer" NOT NULL,
    "severity" "DefectSeverity",
    "notes" TEXT,

    CONSTRAINT "inspection_items_pkey" PRIMARY KEY ("id"),
    -- A failed item must carry a severity so it can be turned into a defect.
    CONSTRAINT "inspection_items_fail_severity_check" CHECK ("answer" <> 'fail' OR "severity" IS NOT NULL)
);

-- CreateIndex
CREATE UNIQUE INDEX "drivers_tenant_id_linked_user_id_key" ON "drivers"("tenant_id", "linked_user_id");
CREATE UNIQUE INDEX "driver_shifts_id_tenant_id_key" ON "driver_shifts"("id", "tenant_id");
CREATE INDEX "driver_shifts_tenant_id_driver_id_started_at_idx" ON "driver_shifts"("tenant_id", "driver_id", "started_at");
CREATE UNIQUE INDEX "shift_events_tenant_id_client_ref_key" ON "shift_events"("tenant_id", "client_ref");
CREATE INDEX "shift_events_shift_id_occurred_at_idx" ON "shift_events"("shift_id", "occurred_at");
CREATE UNIQUE INDEX "vehicle_checkouts_id_tenant_id_key" ON "vehicle_checkouts"("id", "tenant_id");
CREATE INDEX "vehicle_checkouts_tenant_id_vehicle_id_opened_at_idx" ON "vehicle_checkouts"("tenant_id", "vehicle_id", "opened_at");
CREATE UNIQUE INDEX "inspections_id_tenant_id_key" ON "inspections"("id", "tenant_id");
CREATE UNIQUE INDEX "inspections_tenant_id_client_ref_key" ON "inspections"("tenant_id", "client_ref");
CREATE INDEX "inspections_tenant_id_vehicle_id_performed_at_idx" ON "inspections"("tenant_id", "vehicle_id", "performed_at");

-- Database-enforced exclusivity (BR03): one open shift per driver, one open checkout per vehicle and per driver.
CREATE UNIQUE INDEX "driver_shifts_one_open_per_driver" ON "driver_shifts"("driver_id") WHERE "status" = 'open';
CREATE UNIQUE INDEX "vehicle_checkouts_one_open_per_vehicle" ON "vehicle_checkouts"("vehicle_id") WHERE "status" = 'open';
CREATE UNIQUE INDEX "vehicle_checkouts_one_open_per_driver" ON "vehicle_checkouts"("driver_id") WHERE "status" = 'open';

-- AddForeignKey
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_driver_id_tenant_id_fkey" FOREIGN KEY ("driver_id", "tenant_id") REFERENCES "drivers"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shift_events" ADD CONSTRAINT "shift_events_shift_id_tenant_id_fkey" FOREIGN KEY ("shift_id", "tenant_id") REFERENCES "driver_shifts"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_checkouts" ADD CONSTRAINT "vehicle_checkouts_vehicle_id_tenant_id_fkey" FOREIGN KEY ("vehicle_id", "tenant_id") REFERENCES "vehicles"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_checkouts" ADD CONSTRAINT "vehicle_checkouts_driver_id_tenant_id_fkey" FOREIGN KEY ("driver_id", "tenant_id") REFERENCES "drivers"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_vehicle_id_tenant_id_fkey" FOREIGN KEY ("vehicle_id", "tenant_id") REFERENCES "vehicles"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inspection_items" ADD CONSTRAINT "inspection_items_inspection_id_tenant_id_fkey" FOREIGN KEY ("inspection_id", "tenant_id") REFERENCES "inspections"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Shift events are append-only: a database trigger rejects UPDATE and DELETE.
CREATE OR REPLACE FUNCTION "shift_events_reject_change"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'shift_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "shift_events_append_only"
    BEFORE UPDATE OR DELETE ON "shift_events"
    FOR EACH ROW EXECUTE FUNCTION "shift_events_reject_change"();
