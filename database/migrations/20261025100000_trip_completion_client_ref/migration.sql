-- Idempotency key for trip completion, so an offline retry of a completed close is a no-op.
ALTER TABLE "trips" ADD COLUMN "end_client_ref" TEXT;
CREATE UNIQUE INDEX "trips_tenant_id_end_client_ref_key" ON "trips"("tenant_id", "end_client_ref");
