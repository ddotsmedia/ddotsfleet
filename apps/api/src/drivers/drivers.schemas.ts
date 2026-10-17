import { z } from "zod";

const LICENCE_CLASS = /^[A-Z0-9]{1,4}$/;

const isoDate = z.iso.date().transform((s) => new Date(`${s}T00:00:00.000Z`));
const isoDateTime = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

const driverFields = {
  employeeCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{1,32}$/),
  fullName: z.string().trim().min(2).max(120),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ]{6,20}$/)
    .nullable(),
};

export const createDriverSchema = z.object({
  employeeCode: driverFields.employeeCode,
  fullName: driverFields.fullName,
  phone: driverFields.phone.optional(),
});

export const updateDriverSchema = z
  .object({
    fullName: driverFields.fullName.optional(),
    phone: driverFields.phone.optional(),
    status: z.enum(["active", "suspended", "left"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "empty_patch" });

export const listDriversSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(["active", "suspended", "left"]).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const createLicenceSchema = z.object({
  issuingCountry: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/),
  licenceNumber: z.string().trim().toUpperCase().min(1).max(40),
  licenceClasses: z
    .array(z.string().trim().toUpperCase().regex(LICENCE_CLASS))
    .min(1)
    .max(10)
    .transform((c) => [...new Set(c)]),
  expiresAt: isoDate,
});

export const issueAssignmentSchema = z.object({
  vehicleId: z.uuid(),
  driverId: z.uuid(),
  startOdometer: z.number().int().min(0).max(9_999_999),
  startAt: isoDateTime.optional(),
  licenceOverrideReason: z.string().trim().min(10).max(500).optional(),
});

export const endAssignmentSchema = z.object({
  endOdometer: z.number().int().min(0).max(9_999_999),
  endAt: isoDateTime.optional(),
});

export const listAssignmentsSchema = z.object({
  vehicleId: z.uuid().optional(),
  driverId: z.uuid().optional(),
  status: z.enum(["active", "ended"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CreateDriverInput = z.infer<typeof createDriverSchema>;
export type UpdateDriverInput = z.infer<typeof updateDriverSchema>;
export type ListDriversQuery = z.infer<typeof listDriversSchema>;
export type CreateLicenceInput = z.infer<typeof createLicenceSchema>;
export type IssueAssignmentInput = z.infer<typeof issueAssignmentSchema>;
export type EndAssignmentInput = z.infer<typeof endAssignmentSchema>;
export type ListAssignmentsQuery = z.infer<typeof listAssignmentsSchema>;
