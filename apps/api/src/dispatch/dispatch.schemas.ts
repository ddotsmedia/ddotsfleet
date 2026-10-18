import { z } from "zod";

const ref = z.string().trim().min(1).max(100);
const when = z.iso.datetime({ offset: true });
const limit = z.coerce.number().int().min(1).max(100).default(50);
const odometer = z.number().int().min(0).max(10_000_000);
const day = z.iso.date();
const text = (max: number) => z.string().trim().min(1).max(max);

export const startTripSchema = z.object({
  vehicleId: z.uuid(),
  driverId: z.uuid(),
  shiftId: z.uuid().optional(),
  jobId: z.uuid().optional(),
  purpose: text(200),
  originDeclared: text(200),
  destinationDeclared: text(200),
  startOdometer: odometer,
  startedAt: when.optional(),
  clientRef: ref.optional(),
});

export const tripStopSchema = z
  .object({
    eventType: z.enum(["arrived", "departed", "note"]),
    occurredAt: when.optional(),
    odometer: odometer.optional(),
    note: z.string().trim().max(500).optional(),
    clientRef: ref.optional(),
  })
  .refine((s) => s.eventType !== "note" || (s.note !== undefined && s.note.length > 0), {
    message: "note_required",
  });

export const completeTripSchema = z.object({
  endOdometer: odometer,
  endedAt: when.optional(),
});

export const listTripsSchema = z.object({
  vehicleId: z.uuid().optional(),
  driverId: z.uuid().optional(),
  status: z.enum(["open", "completed"]).optional(),
  date: day.optional(),
  limit,
});

export const createJobSchema = z
  .object({
    reference: text(40),
    customerName: text(200),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    plannedStart: when.optional(),
    plannedEnd: when.optional(),
  })
  .refine(
    (j) => !j.plannedStart || !j.plannedEnd || new Date(j.plannedEnd) >= new Date(j.plannedStart),
    {
      message: "invalid_period",
    },
  );

export const assignJobSchema = z.object({
  vehicleId: z.uuid(),
  driverId: z.uuid(),
});

export const jobEventSchema = z
  .object({
    eventType: z.enum(["started", "arrived", "delivered", "note", "completed", "cancelled"]),
    occurredAt: when.optional(),
    note: z.string().trim().max(500).optional(),
    clientRef: ref.optional(),
  })
  .refine((e) => e.eventType !== "note" || (e.note !== undefined && e.note.length > 0), {
    message: "note_required",
  });

export const listJobsSchema = z.object({
  status: z.enum(["planned", "assigned", "in_progress", "completed", "cancelled"]).optional(),
  limit,
});

export const openReviewSchema = z.object({
  vehicleId: z.uuid(),
  operationDate: day,
});

export const reviewNoteSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

export const correctionSchema = z.object({
  note: z.string().trim().min(10).max(500),
});

export const listReviewsSchema = z.object({
  vehicleId: z.uuid().optional(),
  state: z.enum(["draft", "submitted", "correction_requested", "approved", "closed"]).optional(),
  date: day.optional(),
  limit,
});

export type StartTripInput = z.infer<typeof startTripSchema>;
export type TripStopInput = z.infer<typeof tripStopSchema>;
export type CompleteTripInput = z.infer<typeof completeTripSchema>;
export type ListTripsQuery = z.infer<typeof listTripsSchema>;
export type CreateJobInput = z.infer<typeof createJobSchema>;
export type AssignJobInput = z.infer<typeof assignJobSchema>;
export type JobEventInput = z.infer<typeof jobEventSchema>;
export type ListJobsQuery = z.infer<typeof listJobsSchema>;
export type OpenReviewInput = z.infer<typeof openReviewSchema>;
export type ReviewNoteInput = z.infer<typeof reviewNoteSchema>;
export type CorrectionInput = z.infer<typeof correctionSchema>;
export type ListReviewsQuery = z.infer<typeof listReviewsSchema>;
