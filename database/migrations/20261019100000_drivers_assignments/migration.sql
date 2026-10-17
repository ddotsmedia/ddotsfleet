-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('active', 'suspended', 'left');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('active', 'ended');

-- CreateTable
CREATE TABLE "drivers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_code" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "status" "DriverStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_licences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "issuing_country" CHAR(2) NOT NULL,
    "licence_number" TEXT NOT NULL,
    "licence_classes" TEXT[] NOT NULL,
    "expires_at" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "driver_licences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'active',
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6),
    "start_odometer" INTEGER NOT NULL,
    "end_odometer" INTEGER,
    "licence_override" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "ended_by" UUID,

    CONSTRAINT "vehicle_assignments_pkey" PRIMARY KEY ("id"),
    -- Status and end columns must agree; odometer must not decrease (BR05).
    CONSTRAINT "vehicle_assignments_state_check" CHECK (
        (status = 'active' AND end_at IS NULL AND end_odometer IS NULL)
        OR (status = 'ended' AND end_at IS NOT NULL AND end_odometer IS NOT NULL AND end_at >= start_at)
    ),
    CONSTRAINT "vehicle_assignments_odometer_check" CHECK (
        end_odometer IS NULL OR end_odometer >= start_odometer
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "drivers_tenant_id_employee_code_key" ON "drivers"("tenant_id", "employee_code");
CREATE UNIQUE INDEX "drivers_id_tenant_id_key" ON "drivers"("id", "tenant_id");
CREATE INDEX "drivers_tenant_id_status_idx" ON "drivers"("tenant_id", "status");
CREATE UNIQUE INDEX "driver_licences_tenant_id_issuing_country_licence_number_key" ON "driver_licences"("tenant_id", "issuing_country", "licence_number");
CREATE INDEX "driver_licences_driver_id_expires_at_idx" ON "driver_licences"("driver_id", "expires_at");
CREATE UNIQUE INDEX "vehicle_assignments_id_tenant_id_key" ON "vehicle_assignments"("id", "tenant_id");
CREATE INDEX "vehicle_assignments_vehicle_id_start_at_idx" ON "vehicle_assignments"("vehicle_id", "start_at");
CREATE INDEX "vehicle_assignments_driver_id_start_at_idx" ON "vehicle_assignments"("driver_id", "start_at");

-- Database-enforced exclusivity: one active assignment per vehicle and per driver (BR03/BR06 scope for assignments).
CREATE UNIQUE INDEX "vehicle_assignments_one_active_per_vehicle" ON "vehicle_assignments"("vehicle_id") WHERE "status" = 'active';
CREATE UNIQUE INDEX "vehicle_assignments_one_active_per_driver" ON "vehicle_assignments"("driver_id") WHERE "status" = 'active';

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "driver_licences" ADD CONSTRAINT "driver_licences_driver_id_tenant_id_fkey" FOREIGN KEY ("driver_id", "tenant_id") REFERENCES "drivers"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_vehicle_id_tenant_id_fkey" FOREIGN KEY ("vehicle_id", "tenant_id") REFERENCES "vehicles"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_driver_id_tenant_id_fkey" FOREIGN KEY ("driver_id", "tenant_id") REFERENCES "drivers"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
