import { ApiError } from "@/lib/api/errors";
import { storageMessage } from "./storage-state";

export function isStorageExhausted(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "ENOSPC" || code === "SQLITE_FULL" || code === "storage_exhausted") return true;
  // DuckDB's native binding supplies text, not errno. Require an I/O write
  // failure as well as the operating system's no-space sentence.
  return typeof message === "string" && /^(?:IO|I\/O) Error:/i.test(message) &&
    /(?:write|writing|create|creating|open)/i.test(message) && /no space left on device/i.test(message);
}

export function storageExhausted(): ApiError {
  return new ApiError("storage_exhausted", storageMessage(), 507);
}

/** Invoke before source/format wrappers, after their cleanup. Filesystem
 * failures are server errors, never evidence that the user's file is bad. */
export function rethrowStorageFailure(error: unknown): void {
  if (isStorageExhausted(error)) throw storageExhausted();
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "EIO") throw error;
}
