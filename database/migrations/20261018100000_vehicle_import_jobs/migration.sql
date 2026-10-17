-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('previewed', 'committed');

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_by" UUID,
    "status" "ImportStatus" NOT NULL DEFAULT 'previewed',
    "checksum" TEXT NOT NULL,
    "total_rows" INTEGER NOT NULL,
    "valid_rows" INTEGER NOT NULL,
    "error_rows" INTEGER NOT NULL,
    "row_errors" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "committed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_jobs_tenant_id_status_idx" ON "import_jobs"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
