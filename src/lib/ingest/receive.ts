import Busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { dataDir } from "@/lib/config";
import { limits } from "@/lib/limits";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";

export interface ReceivedUpload {
  tmpPath: string;
  filename: string;
}

/** Stream exactly one "file" part to disk. Every stream and pipeline is
 * observed from creation, and failure stops and settles them before unlink.
 * Successful reception still means the destination has finished writing. */
export async function receiveUpload(request: Request): Promise<ReceivedUpload> {
  const interrupted = () => new ApiError(
    "invalid_request",
    "The upload was interrupted or its multipart data is incomplete.",
    400,
  );
  const storageFailure = () => new ApiError(
    "internal",
    "The upload could not be written to storage.",
    500,
  );
  let failure: ApiError | EvaluationCancelled | undefined;
  const streams = new Set<Readable | Writable>();
  // These promises always fulfill: each rejection is owned immediately,
  // with the initiating refusal retained separately from cancellation fallout.
  const work: Promise<void>[] = [];
  const fail = (error: ApiError | EvaluationCancelled) => {
    if (!failure || (error instanceof EvaluationCancelled &&
      failure instanceof ApiError && failure.status === 400)) {
      failure = error;
    }
    // Busboy can be inside a file/limit callback. Let that parser turn
    // finish before destruction changes its active file stream.
    // Destroy with the reason: the parser may already have ended a stream
    // that still holds bytes, and a pipeline whose ended source closes
    // without an error waits for an "end" that never comes.
    queueMicrotask(() => {
      for (const stream of streams) stream.destroy(failure);
    });
  };
  const observe = (pending: Promise<void>, classify: () => ApiError) => {
    const owned = pending.catch(() => { fail(classify()); });
    work.push(owned);
    return owned;
  };
  const own = <T extends Readable | Writable>(stream: T, classify: () => ApiError): T => {
    streams.add(stream);
    // End/error can precede asynchronous destruction. Own close itself,
    // so a pending disk operation or Web cancellation cannot outlive us.
    work.push(new Promise<void>((resolve) => stream.once("close", resolve)));
    // Record the origin before pipeline forwards its error to siblings.
    stream.on("error", () => fail(classify()));
    observe(finished(stream, { cleanup: true }), classify);
    return stream;
  };
  const abort = () => fail(new EvaluationCancelled());
  request.signal.addEventListener("abort", abort, { once: true });

  let tmpPath: string | undefined;
  let filename: string | undefined;
  try {
    if (request.signal.aborted) abort();
    const contentType = request.headers.get("content-type") ?? "";
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
    } catch {
      throw storageFailure();
    }
    if (failure) throw failure;
    tmpPath = path.join(tmpDir, randomUUID());
    let bb: ReturnType<typeof Busboy>;
    try {
      bb = own(Busboy({
        headers: { "content-type": contentType },
        limits: { files: 1, fileSize: limits.uploadMaxBytes },
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
      part.on("limit", () => fail(new ApiError(
        "upload_too_large",
        `Upload exceeds the size cap of ${Math.round(
          limits.uploadMaxBytes / (1024 * 1024),
        )} MB. Raise DEZFIL_UPLOAD_MAX_MB to change it.`,
        413,
      )));
      try {
        const destination = own(createWriteStream(tmpPath!), storageFailure);
        observe(pipeline(part, destination), storageFailure);
      } catch {
        fail(storageFailure());
      }
    });
    bb.on("filesLimit", () => fail(new ApiError(
      "invalid_request",
      "The upload holds more than one file. Send one file per " +
        "request, and repeat the request for a batch.",
      400,
    )));
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
    return { tmpPath, filename };
  } catch (error) {
    fail(error instanceof ApiError || error instanceof EvaluationCancelled
      ? error : interrupted());
    await Promise.all(work);
    if (tmpPath) await rm(tmpPath, { force: true });
    throw failure;
  } finally {
    request.signal.removeEventListener("abort", abort);
  }
}
