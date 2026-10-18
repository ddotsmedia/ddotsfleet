import { z } from "zod";

const isoDate = z.iso.date().transform((s) => new Date(`${s}T00:00:00.000Z`));
const fils = z.number().int().min(0).max(100_000_000);

export const createPlanSchema = z
  .object({
    vehicleId: z.uuid(),
    name: z.string().trim().min(2).max(120),
    intervalKm: z.number().int().min(1).max(1_000_000).optional(),
    intervalDays: z.number().int().min(1).max(3650).optional(),
    nextDueOdometer: z.number().int().min(0).max(9_999_999).optional(),
    nextDueDate: isoDate.optional(),
  })
  .refine((v) => v.intervalKm !== undefined || v.intervalDays !== undefined, {
    message: "interval_required",
  });

export const listPlansSchema = z.object({
  vehicleId: z.uuid().optional(),
  status: z.enum(["active", "retired"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const createWorkOrderSchema = z.object({
  vehicleId: z.uuid(),
  planId: z.uuid().optional(),
  title: z.string().trim().min(3).max(200),
  vendorName: z.string().trim().min(2).max(120).optional(),
  labourFils: fils.default(0),
  partsFils: fils.default(0),
});

export const completeWorkOrderSchema = z.object({
  odometer: z.number().int().min(0).max(9_999_999),
  serviceOn: isoDate,
  labourFils: fils.optional(),
  partsFils: fils.optional(),
  invoiceNumber: z.string().trim().min(1).max(60).optional(),
});

export const listWorkOrdersSchema = z.object({
  vehicleId: z.uuid().optional(),
  status: z.enum(["open", "approved", "completed", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const serviceHistorySchema = z.object({
  vehicleId: z.uuid(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const reportDefectSchema = z.object({
  vehicleId: z.uuid(),
  severity: z.enum(["minor", "major", "critical"]),
  description: z.string().trim().min(5).max(500),
});

export const clearDefectSchema = z.object({
  clearanceNote: z.string().trim().min(10).max(500),
});

export const listDefectsSchema = z.object({
  vehicleId: z.uuid().optional(),
  status: z.enum(["open", "cleared"]).optional(),
  severity: z.enum(["minor", "major", "critical"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const dispatchStatusSchema = z.object({ vehicleId: z.uuid() });

export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type ListPlansQuery = z.infer<typeof listPlansSchema>;
export type CreateWorkOrderInput = z.infer<typeof createWorkOrderSchema>;
export type CompleteWorkOrderInput = z.infer<typeof completeWorkOrderSchema>;
export type ListWorkOrdersQuery = z.infer<typeof listWorkOrdersSchema>;
export type ServiceHistoryQuery = z.infer<typeof serviceHistorySchema>;
export type ReportDefectInput = z.infer<typeof reportDefectSchema>;
export type ClearDefectInput = z.infer<typeof clearDefectSchema>;
export type ListDefectsQuery = z.infer<typeof listDefectsSchema>;
