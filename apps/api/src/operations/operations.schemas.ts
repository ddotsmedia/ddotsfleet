import { z } from "zod";

const ref = z.string().trim().min(1).max(100);
const when = z.iso.datetime({ offset: true });
const limit = z.coerce.number().int().min(1).max(100).default(50);
const percent = z.number().int().min(0).max(100);
const odometer = z.number().int().min(0).max(10_000_000);

export const startShiftSchema = z.object({
  driverId: z.uuid(),
  startedAt: when.optional(),
});

export const shiftEventSchema = z.object({
  eventType: z.enum(["break_start", "break_end"]),
  occurredAt: when.optional(),
  clientRef: ref.optional(),
});

export const endShiftSchema = z.object({
  endedAt: when.optional(),
});

export const listShiftsSchema = z.object({
  driverId: z.uuid().optional(),
  status: z.enum(["open", "closed"]).optional(),
  limit,
});

export const openCheckoutSchema = z.object({
  vehicleId: z.uuid(),
  driverId: z.uuid(),
  shiftId: z.uuid().optional(),
  openingOdometer: odometer,
  openingFuelPercent: percent,
  openingDamageNotes: z.string().trim().max(1000).optional(),
});

export const returnCheckoutSchema = z.object({
  closingOdometer: odometer,
  closingFuelPercent: percent,
  closingDamageNotes: z.string().trim().max(1000).optional(),
});

export const listCheckoutsSchema = z.object({
  vehicleId: z.uuid().optional(),
  driverId: z.uuid().optional(),
  status: z.enum(["open", "returned"]).optional(),
  limit,
});

const inspectionItemSchema = z
  .object({
    code: z.string().trim().min(1).max(40),
    label: z.string().trim().min(1).max(200),
    answer: z.enum(["pass", "fail", "na"]),
    severity: z.enum(["minor", "major", "critical"]).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .refine((item) => item.answer !== "fail" || item.severity !== undefined, {
    message: "severity_required",
  });

export const recordInspectionSchema = z.object({
  vehicleId: z.uuid(),
  checkoutId: z.uuid().optional(),
  kind: z.enum(["pre_trip", "post_trip"]),
  clientRef: ref.optional(),
  items: z.array(inspectionItemSchema).min(1).max(100),
});

export const listInspectionsSchema = z.object({
  vehicleId: z.uuid().optional(),
  limit,
});

export type StartShiftInput = z.infer<typeof startShiftSchema>;
export type ShiftEventInput = z.infer<typeof shiftEventSchema>;
export type EndShiftInput = z.infer<typeof endShiftSchema>;
export type ListShiftsQuery = z.infer<typeof listShiftsSchema>;
export type OpenCheckoutInput = z.infer<typeof openCheckoutSchema>;
export type ReturnCheckoutInput = z.infer<typeof returnCheckoutSchema>;
export type ListCheckoutsQuery = z.infer<typeof listCheckoutsSchema>;
export type RecordInspectionInput = z.infer<typeof recordInspectionSchema>;
export type ListInspectionsQuery = z.infer<typeof listInspectionsSchema>;
