import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import {
  ApiError,
  errorResponse,
  EvaluationCancelled,
} from "@/lib/api/errors";
import { getLayer } from "@/lib/metadata/maps";
import {
  exportLayerResult,
  isLayerExportFormat,
  type LayerExportFormat,
} from "@/lib/export/layer-export";
import {
  layerDownloadTickets,
  observeLayerDownloadStream,
  type LayerDownloadBinding,
} from "@/lib/export/layer-download-tickets";
import { trackInflight } from "@/lib/query/inflight";

type Params = { params: Promise<{ id: string; format: string }> };

type UiMode =
  | { kind: "direct" }
  | { kind: "invalid" }
  | { kind: "prepare" }
  | { kind: "download"; ticket: string }
  | { kind: "status"; ticket: string; release: boolean };

function exactSingle(
  search: URLSearchParams,
  key: string,
  accepts: (value: string) => boolean,
): string | null {
  const values = search.getAll(key);
  return values.length === 1 && accepts(values[0]) ? values[0] : null;
}

/** Only the exact private markers activate; lookalikes stay on bare GET. */
function uiMode(request: Request): UiMode {
  const search = new URL(request.url).searchParams;
  const prepare = exactSingle(search, "__ui_prepare", (value) => value === "1");
  const download = exactSingle(
    search,
    "__ui_download",
    (value) => value.length > 0,
  );
  const status = exactSingle(
    search,
    "__ui_status",
    (value) => value.length > 0,
  );
  const recognized =
    Number(prepare !== null) +
    Number(download !== null) +
    Number(status !== null);
  if (recognized > 1) return { kind: "invalid" };
  if (prepare !== null) return { kind: "prepare" };
  if (download !== null) return { kind: "download", ticket: download };
  if (status !== null) {
    return {
      kind: "status",
      ticket: status,
      release:
        exactSingle(search, "__ui_release", (value) => value === "1") !==
        null,
    };
  }
  return { kind: "direct" };
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

function unavailable(): ApiError {
  return new ApiError(
    "invalid_request",
    "This prepared download is no longer available.",
    400,
  );
}

/** Download a layer's effective result: SQL, then stored
 * filters, then OD/aggregation — exactly as the builder renders it —
 * written on the hardened instance through the bounded lane and streamed
 * as an attachment. The caller's departure cancels the evaluation. */
export async function GET(request: Request, { params }: Params) {
  const mode = uiMode(request);
  try {
    const { id, format } = await params;
    if (!isLayerExportFormat(format)) {
      throw new ApiError(
        "invalid_request",
        `Unknown export format "${format}". Use geoparquet, geojson, or csv.`,
        400,
      );
    }
    const binding: LayerDownloadBinding = { layerId: id, format };

    if (mode.kind === "invalid") {
      throw new ApiError(
        "invalid_request",
        "Conflicting private download markers.",
        400,
      );
    }
    if (mode.kind === "status") {
      if (mode.release) {
        if (!(await layerDownloadTickets.release(mode.ticket, binding))) {
          throw unavailable();
        }
        return noStore(new NextResponse(null, { status: 204 }));
      }
      const status = layerDownloadTickets.status(mode.ticket, binding);
      if (!status) throw unavailable();
      return NextResponse.json(
        { status },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (mode.kind === "download") {
      return await preparedDownload(request, binding, mode.ticket);
    }

    const layer = getLayer(id);
    if (!layer) {
      throw new ApiError("not_found", `No layer with id "${id}".`, 404);
    }
    if (mode.kind === "prepare") {
      return await prepareDownload(request, layer, binding);
    }

    return await directDownload(request, layer, format);
  } catch (error) {
    const response = errorResponse(error);
    return mode.kind === "direct" ? response : noStore(response);
  }
}

async function prepareDownload(
  request: Request,
  layer: NonNullable<ReturnType<typeof getLayer>>,
  binding: LayerDownloadBinding,
): Promise<NextResponse> {
  let ticket: string | null = null;
  try {
    if (request.signal.aborted) throw new EvaluationCancelled();
    ticket = await trackInflight(
      (async () => {
        const file = await exportLayerResult(
          layer,
          binding.format,
          request.signal,
        );
        try {
          const size = (await stat(file.path)).size;
          return layerDownloadTickets.prepare(
            binding,
            { ...file, size },
            request.signal,
          );
        } catch (error) {
          await file.cleanup().catch(() => undefined);
          throw error;
        }
      })(),
    );
    if (request.signal.aborted) throw new EvaluationCancelled();

    return NextResponse.json(
      { ticket },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (ticket !== null) {
      await layerDownloadTickets.release(ticket, binding);
    }
    throw error;
  }
}

async function directDownload(
  request: Request,
  layer: NonNullable<ReturnType<typeof getLayer>>,
  format: LayerExportFormat,
): Promise<NextResponse> {
  // The evaluation itself is bounded (and cancels with the caller); the
  // descriptor is then held before the response starts so a concurrent
  // scratch sweep cannot land between write and open.
  const { file, handle, size } = await trackInflight(
    (async () => {
      const file = await exportLayerResult(layer, format, request.signal);
      const handle = await open(file.path);
      const size = (await handle.stat()).size;
      return { file, handle, size };
    })(),
  );
  const stream = handle.createReadStream();
  // The scratch file vanishes once the download (or an abort) closes the
  // stream; the boot sweep covers a process that dies mid-stream.
  stream.once("close", () => void file.cleanup());
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "content-type": file.contentType,
      "content-length": String(size),
      "content-disposition": `attachment; filename="${file.filename}"`,
    },
  });
}

async function preparedDownload(
  request: Request,
  binding: LayerDownloadBinding,
  ticket: string,
): Promise<NextResponse> {
  const claimed = layerDownloadTickets.claim(ticket, binding);
  if (!claimed) throw unavailable();

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(claimed.path);
  } catch {
    claimed.fail();
    throw unavailable();
  }

  if (request.signal.aborted) {
    await handle.close().catch(() => undefined);
    claimed.fail();
    throw new EvaluationCancelled();
  }

  const stream = handle.createReadStream();
  if (!observeLayerDownloadStream(stream, request.signal, claimed)) {
    if (request.signal.aborted) throw new EvaluationCancelled();
    throw unavailable();
  }

  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "content-type": claimed.contentType,
      "content-length": String(claimed.size),
      "content-disposition": `attachment; filename="${claimed.filename}"`,
      "cache-control": "no-store",
    },
  });
}
