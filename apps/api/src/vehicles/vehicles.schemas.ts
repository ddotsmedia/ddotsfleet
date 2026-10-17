import { z } from "zod";
import { Emirate, FuelType, Ownership, VehicleStatus } from "../generated/prisma/client.js";

const upper = (s: string) => s.trim().toUpperCase();
const currentYear = new Date().getFullYear();

const plateNumber = z
  .string()
  .transform((s) => upper(s).replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1)
      .max(16)
      .regex(/^[A-Z0-9][A-Z0-9 -]*$/),
  );

const fleetCode = z
  .string()
  .transform(upper)
  .pipe(
    z
      .string()
      .min(1)
      .max(32)
      .regex(/^[A-Z0-9-]+$/),
  );

// ISO 3779 VIN: 17 characters, no I, O or Q.
const vin = z
  .string()
  .transform(upper)
  .pipe(z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/));

const text = (max: number) => z.string().trim().min(1).max(max);

const vehicleFields = {
  fleetCode: fleetCode.nullish(),
  plateNumber,
  emirate: z.enum(Emirate),
  vin: vin.nullish(),
  category: text(40),
  make: text(60),
  model: text(60),
  year: z
    .number()
    .int()
    .min(1950)
    .max(currentYear + 1)
    .nullish(),
  colour: text(30).nullish(),
  fuelType: z.enum(FuelType),
  ownership: z.enum(Ownership),
  status: z.enum(VehicleStatus).optional(),
};

export const createVehicleSchema = z.object(vehicleFields);

export const updateVehicleSchema = z
  .object(vehicleFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "no_fields" });

export const listVehiclesSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(VehicleStatus).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CreateVehicleInput = z.output<typeof createVehicleSchema>;
export type UpdateVehicleInput = z.output<typeof updateVehicleSchema>;
export type ListVehiclesQuery = z.output<typeof listVehiclesSchema>;
