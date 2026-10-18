-- CreateEnum
CREATE TYPE "DocumentSubjectType" AS ENUM ('vehicle', 'driver');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('vehicle_registration', 'vehicle_insurance', 'driving_licence', 'emirates_id', 'other');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('current', 'superseded');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('pending', 'clean', 'rejected');

-- CreateEnum
CREATE TYPE "RenewalStatus" AS ENUM ('open', 'completed');

-- CreateTable
CREATE TABLE "file_objects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "scan_status" "ScanStatus" NOT NULL DEFAULT 'pending',
    "scanned_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "file_objects_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "file_objects_size_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 5242880)
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_type" "DocumentSubjectType" NOT NULL,
    "subject_id" UUID NOT NULL,
    "doc_type" "DocumentType" NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'current',
    "issued_on" DATE,
    "expires_on" DATE,
    "file_object_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "documents_period_check" CHECK ("expires_on" IS NULL OR "issued_on" IS NULL OR "expires_on" > "issued_on")
);

-- CreateTable
CREATE TABLE "renewals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "status" "RenewalStatus" NOT NULL DEFAULT 'open',
    "due_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by" UUID,

    CONSTRAINT "renewals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "renewals_completion_check" CHECK (("status" = 'open' AND "completed_at" IS NULL) OR ("status" = 'completed' AND "completed_at" IS NOT NULL))
);

-- CreateTable
CREATE TABLE "renewal_reminders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "renewal_id" UUID NOT NULL,
    "stage_days" INTEGER NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "renewal_reminders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "renewal_reminders_stage_check" CHECK ("stage_days" IN (30, 14, 7, 0))
);

-- CreateIndex
CREATE UNIQUE INDEX "file_objects_object_key_key" ON "file_objects"("object_key");
CREATE UNIQUE INDEX "file_objects_id_tenant_id_key" ON "file_objects"("id", "tenant_id");
CREATE UNIQUE INDEX "documents_subject_version_key" ON "documents"("tenant_id", "subject_type", "subject_id", "doc_type", "version");
CREATE UNIQUE INDEX "documents_id_tenant_id_key" ON "documents"("id", "tenant_id");
CREATE INDEX "documents_tenant_id_expires_on_idx" ON "documents"("tenant_id", "expires_on");
CREATE UNIQUE INDEX "renewals_tenant_id_document_id_key" ON "renewals"("tenant_id", "document_id");
CREATE UNIQUE INDEX "renewals_id_tenant_id_key" ON "renewals"("id", "tenant_id");
CREATE INDEX "renewals_tenant_id_status_due_on_idx" ON "renewals"("tenant_id", "status", "due_on");
CREATE UNIQUE INDEX "renewal_reminders_renewal_id_stage_days_key" ON "renewal_reminders"("renewal_id", "stage_days");

-- Database-enforced: at most one current document per subject and document type (replacement is explicit).
CREATE UNIQUE INDEX "documents_one_current_per_subject_doc_type" ON "documents"("tenant_id", "subject_type", "subject_id", "doc_type") WHERE "status" = 'current';

-- AddForeignKey
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents" ADD CONSTRAINT "documents_file_object_id_tenant_id_fkey" FOREIGN KEY ("file_object_id", "tenant_id") REFERENCES "file_objects"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "renewals" ADD CONSTRAINT "renewals_document_id_tenant_id_fkey" FOREIGN KEY ("document_id", "tenant_id") REFERENCES "documents"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "renewal_reminders" ADD CONSTRAINT "renewal_reminders_renewal_id_tenant_id_fkey" FOREIGN KEY ("renewal_id", "tenant_id") REFERENCES "renewals"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
