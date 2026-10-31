import { isStorageExhausted, storageExhausted } from "@/lib/system/storage-errors";
import { createUploadClock, nativeUploadReception, type UploadReception, type ReceptionRefusal } from "@/lib/auth/reception.mjs";
import { settingRemedy } from "@/lib/settings/remedy";
import { registerAccountFile, removeAccountFile } from "./file-ownership";
import Busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { dataDir } from "@/lib/config";
import { captureIngestBudget, type IngestBudget } from "./budget";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";

export interface ReceivedUpload {
  tmpPath: string;
  filename: string;
  budget: IngestBudget;
}

/** What one reception may take and how its refusals read. Bytes are counted
 * as they arrive, whatever length the request declared. */
export interface ReceptionBounds {
  /** The largest file part accepted; one byte more is refused. */
  readonly fileBytes: number;
  /** The largest whole body, envelope included; unbounded when absent. */
  readonly bodyBytes?: number;
  /** How long the body may take to arrive. */
  readonly receiveMs: number;
  /** The refusal of a file part or body over its bound, worded when it happens. */
  readonly tooLarge: () => string;
  /** What the reception time refusal tells the caller to do. */
  readonly timeoutRemedy: string;
}

/** The table upload's bounds: the instance's settings, named in its refusals.
 * A file that reaches the cap is refused, as the cap has always counted. */
function ingestBounds(budget: IngestBudget): ReceptionBounds {
  return {
    fileBytes: budget.uploadMaxBytes - 1,
    receiveMs: budget.dataProcessingTimeoutMs,
    tooLarge: () => `Upload exceeds the size cap of ${Math.round(
      budget.uploadMaxBytes / (1024 * 1024),
    )} MB. ${settingRemedy("uploadMaxMb")}`,
    timeoutRemedy: settingRemedy("dataProcessingTimeoutS"),
  };
}

/** Stream exactly one "file" part to disk. Every stream and pipeline is
 * observed from creation, and failure stops and settles them before unlink.
 * Successful reception still means the destination has finished writing.
 * Without bounds, the table upload's settings bound it. */
export async function receiveUpload(request: Request, accountId?: string, bounds?: ReceptionBounds): Promise<ReceivedUpload> {
  const budget = captureIngestBudget();
  const limit = bounds ?? ingestBounds(budget);
  const tooLarge = () => new ApiError("upload_too_large", limit.tooLarge(), 413);
  const interrupted = () => new ApiError(
    "invalid_request",
    "The upload was interrupted or its multipart data is incomplete.",
    400,
  );
  const storageFailure = (error?: unknown) => isStorageExhausted(error) ? storageExhausted() : new ApiError(
    "internal",
    "The upload could not be written to storage.",
    500,
  );
  let failure: ApiError | EvaluationCancelled | undefined;
  let reception: UploadReception | undefined = undefined;
  const streams = new Set<Readable | Writable>();
  // These promises always fulfill: each rejection is owned immediately,
  // with the initiating refusal retained separately from cancellation fallout.
  const work: Promise<void>[] = [];
  const fail = (error: ApiError | EvaluationCancelled) => {
    // The first refusal wins, except that a caller who leaves after an
    // interrupted body is answered as departed: that interruption was
    // probably the departure itself. Time and size refusals stay first.
    if (!failure || (error instanceof EvaluationCancelled && failure instanceof ApiError && failure.status === 400)) {
      failure = error;
    }
    reception?.refuse(failure instanceof EvaluationCancelled
      ? Object.assign(new Error(failure.message), { code: null, status: 499 }) : failure);
    // Busboy can be inside a file/limit callback. Let that parser turn
    // finish before destruction changes its active file stream.
    // Destroy with the reason: the parser may already have ended a stream
    // that still holds bytes, and a pipeline whose ended source closes
    // without an error waits for an "end" that never comes.
    queueMicrotask(() => {
      for (const stream of streams) stream.destroy(failure);
    });
  };
  const observe = (pending: Promise<void>, classify: (error?: unknown) => ApiError) => {
    const owned = pending.catch(error => { fail(classify(error)); });
    work.push(owned);
    return owned;
  };
  const own = <T extends Readable | Writable>(stream: T, classify: (error?: unknown) => ApiError): T => {
    streams.add(stream);
    // End/error can precede asynchronous destruction. Own close itself,
    // so a pending disk operation or Web cancellation cannot outlive us.
    work.push(new Promise<void>((resolve) => stream.once("close", resolve)));
    // Record the origin before pipeline forwards its error to siblings.
    stream.on("error", error => fail(classify(error)));
    observe(finished(stream, { cleanup: true }), classify);
    return stream;
  };
  const abort = () => fail(new EvaluationCancelled());
  request.signal.addEventListener("abort", abort, { once: true });

  const receptionFailure = (error: ReceptionRefusal) => fail(error.status === 499 ? new EvaluationCancelled()
    : error instanceof ApiError ? error : new ApiError(error.code as import("@/lib/api/errors").ErrorCode, error.message, error.status));
  reception = nativeUploadReception(limit.receiveMs, limit.timeoutRemedy, receptionFailure)
    ?? createUploadClock(limit.receiveMs, limit.timeoutRemedy, receptionFailure);

  let tmpPath: string | undefined;
  let filename: string | undefined;
  try {
    if (request.signal.aborted) abort();
    const contentType = request.headers.get("content-type") ?? "";
    // A body declared over its bound is refused before any of it is read.
    const declared = Number(request.headers.get("content-length") ?? Number.NaN);
    if (limit.bodyBytes !== undefined && declared > limit.bodyBytes) throw tooLarge();
    const source = request.body
      ? own(Readable.fromWeb(request.body as import("stream/web").ReadableStream), interrupted)
      : null;
    if (failure) throw failure;
    if (!contentType.startsWith("multipart/form-data") || !source) {
      throw new ApiError(
        "invalid_request",
        'Expected a multipart/form-data request with a "file" field.',
        400,
      );
    }

    const tmpDir = path.join(dataDir(), "tmp");
    try {
      await mkdir(tmpDir, { recursive: true });
    } catch (error) {
      throw storageFailure(error);
    }
    if (failure) throw failure;
    tmpPath = path.join(tmpDir, randomUUID());
    if (accountId) registerAccountFile(accountId, tmpPath);
    let bb: ReturnType<typeof Busboy>;
    try {
      bb = own(Busboy({
        headers: { "content-type": contentType },
        // The parser refuses a part that reaches its limit.
        limits: { files: 1, fileSize: limit.fileBytes + 1 },
      }), interrupted);
    } catch (error) {
      if (error instanceof Error && error.message === "Multipart: Boundary not found") {
        throw new ApiError(
          "invalid_request",
          "The multipart upload is missing its boundary parameter.",
          400,
        );
      }
      throw interrupted();
    }
    bb.on("file", (field, part, info) => {
      own(part, interrupted);
      if (failure) return;
      if (field !== "file") {
        fail(new ApiError(
          "invalid_request",
          'Send the data as a "file" field, one file per request.',
          400,
        ));
        return;
      }
      filename = info.filename;
      part.on("limit", () => fail(tooLarge()));
      try {
        const destination = own(createWriteStream(tmpPath!), storageFailure);
        observe(pipeline(part, destination), storageFailure);
      } catch (error) {
        fail(storageFailure(error));
      }
    });
    bb.on("filesLimit", () => fail(new ApiError(
      "invalid_request",
      "The upload holds more than one file. Send one file per " +
        "request, and repeat the request for a batch.",
      400,
    )));
    let arrived = 0;
    source.on("data", (chunk: Buffer) => {
      reception?.progress();
      arrived += chunk.byteLength;
      if (limit.bodyBytes !== undefined && arrived > limit.bodyBytes) fail(tooLarge());
    });
    source.once("end", () => reception?.endBody());
    await observe(pipeline(source, bb), interrupted);
    // The feed has stopped creating parts. This also waits for destruction
    // and source cancellation, which pipeline rejection alone may precede.
    await Promise.all(work);
    if (failure) throw failure;
    if (!filename) {
      throw new ApiError(
        "invalid_request",
        'The upload contains no file. Send the data as a "file" field.',
        400,
      );
    }
    return { tmpPath, filename, budget };
  } catch (error) {
    fail(error instanceof ApiError || error instanceof EvaluationCancelled
      ? error : isStorageExhausted(error) ? storageExhausted() : interrupted());
    await Promise.all(work);
    if (tmpPath) await removeAccountFile(tmpPath, { force: true });
    throw failure;
  } finally {
    reception.complete();
    request.signal.removeEventListener("abort", abort);
  }
}
