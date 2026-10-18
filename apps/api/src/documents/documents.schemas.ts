import { z } from "zod";

export const SUBJECT_TYPES = ["vehicle", "driver"] as const;
export const DOCUMENT_TYPES = [
  "vehicle_registration",
  "vehicle_insurance",
  "driving_licence",
  "emirates_id",
  "other",
] as const;
export const CONTENT_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const isoDate = z.iso.date().transform((s) => new Date(`${s}T00:00:00.000Z`));

export const uploadDocumentSchema = z
  .object({
    subjectType: z.enum(SUBJECT_TYPES),
    subjectId: z.uuid(),
    docType: z.enum(DOCUMENT_TYPES),
    issuedOn: isoDate.optional(),
    expiresOn: isoDate.optional(),
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((n) => !/[\\/]/.test(n) && ![...n].some((c) => c.charCodeAt(0) < 32), {
        message: "invalid_file_name",
      }),
    contentType: z.enum(CONTENT_TYPES),
    // Base64 of at most MAX_FILE_BYTES; the 10mb JSON body limit covers this.
    contentBase64: z
      .string()
      .min(4)
      .max(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .refine((v) => !v.issuedOn || !v.expiresOn || v.expiresOn > v.issuedOn, {
    message: "invalid_period",
  });

export const listDocumentsSchema = z.object({
  subjectType: z.enum(SUBJECT_TYPES).optional(),
  subjectId: z.uuid().optional(),
  status: z.enum(["current", "superseded"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const listRenewalsSchema = z.object({
  status: z.enum(["open", "completed"]).default("open"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;
export type ListDocumentsQuery = z.infer<typeof listDocumentsSchema>;
export type ListRenewalsQuery = z.infer<typeof listRenewalsSchema>;
