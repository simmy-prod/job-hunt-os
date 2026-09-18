export type ErrorCode = "CONFIG" | "SCHEMA" | "AUTH" | "NOTION" | "INPUT" | "STORAGE" | "POLICY";

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
