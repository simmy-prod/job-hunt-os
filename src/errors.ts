import { z } from "zod";

export const errorCodeSchema = z.enum(["CONFIG", "SCHEMA", "AUTH", "NOTION", "SOURCE", "INPUT", "STORAGE", "POLICY", "LOCKED"]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export class AppError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
  }
}

// Raw provider errors may contain credentials, request bodies, or private rows.
export function safeError(error: unknown): AppError {
  return error instanceof AppError
    ? error
    : new AppError("INPUT", "Operation failed. Check configuration and input contracts; raw error details were withheld.");
}

// Shared between the top-level CLI error handler and doctor's own report so the
// process-exit contract stays in one place.
export function exitCodeFor(code: ErrorCode): number {
  return code === "NOTION" || code === "SOURCE" ? 3 : code === "STORAGE" ? 4 : code === "LOCKED" ? 5 : 2;
}
