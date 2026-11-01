import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { ApiError } from "@/lib/api/errors";
import { storageMessage } from "./storage-state";

function engineIoFailure(error: unknown, reason: RegExp): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && /^(?:IO|I\/O) Error:/i.test(message) &&
    /(?:write|writing|create|creating|open)/i.test(message) && reason.test(message);
}

export function isStorageExhausted(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code } = error as { code?: unknown };
  if (code === "ENOSPC" || code === "SQLITE_FULL" || code === "storage_exhausted") return true;
  // DuckDB's native binding supplies text, not errno. Require an I/O write
  // failure ending in the operating system's reason, outside quoted paths.
  return engineIoFailure(error, /: No space left on device\s*$/i);
}

export function storageExhausted(): ApiError {
  return new ApiError("storage_exhausted", storageMessage(), 507);
}

/** Invoke before source/format wrappers, after their cleanup. Filesystem
 * failures are server errors, never evidence that the user's file is bad. */
export function storageFailure(error: unknown): ApiError | null {
  if (isStorageExhausted(error)) return storageExhausted();
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "EIO" ||
    engineIoFailure(error, /: (?:Permission denied|Operation not permitted|Read-only file system|Input\/output error)\s*$/i)) {
    return new ApiError("internal", ERROR_CATALOGUE.internal, 500);
  }
  return null;
}

export function rethrowStorageFailure(error: unknown): void {
  const failure = storageFailure(error);
  if (failure) throw failure;
}
