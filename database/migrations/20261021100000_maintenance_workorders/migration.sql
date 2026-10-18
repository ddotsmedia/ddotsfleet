-- CreateEnum
CREATE TYPE "MaintenancePlanStatus" AS ENUM ('active', 'retired');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('open', 'approved', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "DefectSeverity" AS ENUM ('minor', 'major', 'critical');

-- CreateEnum
CREATE TYPE "DefectStatus" AS ENUM ('open', 'cleared');

-- CreateTable
CREATE TABLE "maintenance_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "interval_km" INTEGER,
    "interval_days" INTEGER,
    "next_due_odometer" INTEGER,
    "next_due_date" DATE,
    "status" "MaintenancePlanStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "maintenance_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "maintenance_plans_interval_check" CHECK (
        ("interval_km" IS NOT NULL AND "interval_km" > 0) OR ("interval_days" IS NOT NULL AND "interval_days" > 0)
    )
);

-- CreateTable
CREATE TABLE "work_orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "plan_id" UUID,
    "title" TEXT NOT NULL,
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'open',
    "vendor_name" TEXT,
    "labour_fils" INTEGER NOT NULL DEFAULT 0,
    "parts_fils" INTEGER NOT NULL DEFAULT 0,
    "invoice_number" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "completed_by" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "work_orders_amounts_check" CHECK ("labour_fils" >= 0 AND "parts_fils" >= 0),
    CONSTRAINT "work_orders_state_check" CHECK (
        ("status" = 'open' AND "approved_at" IS NULL AND "completed_at" IS NULL AND "cancelled_at" IS NULL)
        OR ("status" = 'approved' AND "approved_at" IS NOT NULL AND "completed_at" IS NULL AND "cancelled_at" IS NULL)
        OR ("status" = 'completed' AND "approved_at" IS NOT NULL AND "completed_at" IS NOT NULL AND "cancelled_at" IS NULL)
        OR ("status" = 'cancelled' AND "cancelled_at" IS NOT NULL AND "completed_at" IS NULL)
    )
);

-- CreateTable
CREATE TABLE "service_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "work_order_id" UUID NOT NULL,
    "service_on" DATE NOT NULL,
    "odometer" INTEGER NOT NULL,
    "vendor_name" TEXT,
    "labour_fils" INTEGER NOT NULL,
    "parts_fils" INTEGER NOT NULL,
    "invoice_number" TEXT,
    "recorded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_events_odometer_check" CHECK ("odometer" >= 0 AND "labour_fils" >= 0 AND "parts_fils" >= 0)
);

-- CreateTable
CREATE TABLE "defects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "severity" "DefectSeverity" NOT NULL,
    "status" "DefectStatus" NOT NULL DEFAULT 'open',
    "description" TEXT NOT NULL,
    "reported_by" UUID,
    "reported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleared_by" UUID,
    "cleared_at" TIMESTAMPTZ(6),
    "clearance_note" TEXT,

    CONSTRAINT "defects_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "defects_clearance_check" CHECK (
        ("status" = 'open' AND "cleared_at" IS NULL)
        OR ("status" = 'cleared' AND "cleared_at" IS NOT NULL AND "clearance_note" IS NOT NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_plans_id_tenant_id_key" ON "maintenance_plans"("id", "tenant_id");
CREATE INDEX "maintenance_plans_tenant_id_vehicle_id_idx" ON "maintenance_plans"("tenant_id", "vehicle_id");
CREATE UNIQUE INDEX "work_orders_id_tenant_id_key" ON "work_orders"("id", "tenant_id");
CREATE INDEX "work_orders_tenant_id_status_idx" ON "work_orders"("tenant_id", "status");
CREATE INDEX "work_orders_vehicle_id_idx" ON "work_orders"("vehicle_id");
CREATE UNIQUE INDEX "service_events_work_order_id_tenant_id_key" ON "service_events"("work_order_id", "tenant_id");
CREATE INDEX "service_events_tenant_id_vehicle_id_service_on_idx" ON "service_events"("tenant_id", "vehicle_id", "service_on");
CREATE UNIQUE INDEX "defects_id_tenant_id_key" ON "defects"("id", "tenant_id");
CREATE INDEX "defects_tenant_id_vehicle_id_status_idx" ON "defects"("tenant_id", "vehicle_id", "status");

-- AddForeignKey
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_vehicle_id_tenant_id_fkey" FOREIGN KEY ("vehicle_id", "tenant_id") REFERENCES "vehicles"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_vehicle_id_tenant_id_fkey" FOREIGN KEY ("vehicle_id", "tenant_id") REFERENCES "vehicles"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_vehicle_id_tenant_id_fkey" FOREIGN KEY ("vehicle_id", "tenant_id") REFERENCES "vehicles"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_work_order_id_tenant_id_fkey" FOREIGN KEY ("work_order_id", "tenant_id") REFERENCES "work_orders"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "defects" ADD CONSTRAINT "defects_vehicle_id_tenant_id_fkey" FOREIGN KEY ("vehicle_id", "tenant_id") REFERENCES "vehicles"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Service history is append-only: a database trigger rejects UPDATE and DELETE.
CREATE OR REPLACE FUNCTION "service_events_reject_change"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'service_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "service_events_append_only"
    BEFORE UPDATE OR DELETE ON "service_events"
    FOR EACH ROW EXECUTE FUNCTION "service_events_reject_change"();
