-- CreateEnum
CREATE TYPE "Emirate" AS ENUM ('abu_dhabi', 'ajman', 'dubai', 'fujairah', 'ras_al_khaimah', 'sharjah', 'umm_al_quwain');

-- CreateEnum
CREATE TYPE "FuelType" AS ENUM ('petrol', 'diesel', 'hybrid', 'electric', 'lpg');

-- CreateEnum
CREATE TYPE "Ownership" AS ENUM ('owned', 'leased', 'rented');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('active', 'maintenance', 'retired');

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fleet_code" TEXT,
    "plate_number" TEXT NOT NULL,
    "emirate" "Emirate" NOT NULL,
    "vin" TEXT,
    "category" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER,
    "colour" TEXT,
    "fuel_type" "FuelType" NOT NULL,
    "ownership" "Ownership" NOT NULL,
    "status" "VehicleStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_tenant_id_plate_number_key" ON "vehicles"("tenant_id", "plate_number");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_tenant_id_fleet_code_key" ON "vehicles"("tenant_id", "fleet_code");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_id_tenant_id_key" ON "vehicles"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "vehicles_tenant_id_status_idx" ON "vehicles"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_entity_type_entity_id_idx" ON "audit_events"("tenant_id", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only audit log: reject any UPDATE or DELETE, including from the application role.
CREATE FUNCTION "audit_events_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only';
END;
$$;

CREATE TRIGGER "audit_events_append_only"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION "audit_events_reject_change"();
