import { limits } from "@/lib/limits";

/** Capture before the first asynchronous stage. Archive expansion uses the
 * upload ceiling on both upload and link-import roads. */
export interface IngestBudget {
  readonly dataProcessingTimeoutMs: number;
  readonly uploadMaxBytes: number;
  readonly remoteMaxBytes: number;
  readonly remoteTimeoutMs: number;
}

export function captureIngestBudget(): IngestBudget {
  return Object.freeze({ dataProcessingTimeoutMs: limits.dataProcessingTimeoutMs, uploadMaxBytes: limits.uploadMaxBytes,
    remoteMaxBytes: limits.remoteMaxBytes, remoteTimeoutMs: limits.remoteTimeoutMs });
}
