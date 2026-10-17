import { BadRequestException } from "@nestjs/common";
import type { z } from "zod";

/** Parses untrusted input; the error never echoes the rejected values. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException("invalid_input");
  return result.data;
}

/** Minimal request/response shapes so controllers need no express type packages. */
export interface CookieRequest {
  headers: Record<string, string | string[] | undefined>;
  auth?: AuthContext;
}

export interface CookieResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): void;
  clearCookie(name: string, options: Record<string, unknown>): void;
}

export interface AuthContext {
  userId: string;
  email: string;
  sessionId: string;
}
