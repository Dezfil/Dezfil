import type { AccountScope } from "@/lib/auth/scope";
import { openPrivateExport } from "@/lib/export/private-file";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import {
  DATASET_FORMATS,
  DEFAULT_DATASET_FORMAT,
  isDatasetFormat,
  type DatasetFormat,
} from "@/lib/export/dataset-format";
import {
  assembleProjectExport,
  type ProjectExportSelection,
} from "@/lib/export/project-export";
import {
  claimProjectExportTicket,
  createProjectExportTicket,
} from "@/lib/export/project-export-tickets";

interface Params {
  params: Promise<{ id: string }>;
}

/** The optional dataset format: omitted is the
 * stored GeoParquet; anything else must be one of the three. */
function datasetFormatOf(value: unknown): DatasetFormat {
  if (value === undefined || value === null) return DEFAULT_DATASET_FORMAT;
  if (isDatasetFormat(value)) return value;
  throw new ApiError(
    "invalid_request",
    `datasetFormat must be one of ${DATASET_FORMATS.join(", ")}.`,
    400,
  );
}

const idList = (raw: unknown, field: string): string[] => {
  if (raw === undefined) return [];
  if (
    !Array.isArray(raw) ||
    raw.some((v) => typeof v !== "string" || v === "")
  ) {
    throw new ApiError(
      "invalid_request",
      `"${field}" must be an array of member ids.`,
      400,
    );
  }
  return raw as string[];
};

/** Stream a finalized staged archive as the attachment, deleting it
 * when the stream closes, however it closes. */
async function streamStaged(scope: AccountScope, prepared: {
  path: string;
  filename: string;
  size: number;
}) {
  const { handle } = await openPrivateExport(scope, { ...prepared, cleanup: () => rm(prepared.path, { force: true }) });
  const stream = handle.createReadStream();
  stream.once("close", () => {
    void rm(prepared.path, { force: true }).catch(() => {});
  });
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "content-type": "application/zip",
      "content-length": String(prepared.size),
      "content-disposition": `attachment; filename="${prepared.filename}"`,
    },
  });
}

/** The 16-C archive: assemble and finalize on disk —
 * every failure answers a coded refusal before any success exists.
 * Without `prepare`, the attachment streams directly (the agent road);
 * with it, a single-use ticket for the page's native anchor redemption
 * (the / road). */
export async function POST(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    const body = (await request.json().catch(() => {
      throw new ApiError("invalid_request", "A JSON body is required.", 400);
    })) as Record<string, unknown>;
    const selection: ProjectExportSelection = {
      maps: idList(body.maps, "maps"),
      recipes: idList(body.workflows, "workflows"),
      tables: idList(body.datasets, "datasets"),
      file: typeof body.file === "string" ? body.file : "",
      datasetFormat: datasetFormatOf(body.datasetFormat),
    };
    const prepared = await assembleProjectExport(scope, id, selection);
    if (body.prepare !== true) return await streamStaged(scope, prepared);
    const { ticket, key } = createProjectExportTicket(scope, id, prepared);
    return NextResponse.json({
      ticket,
      key,
      filename: prepared.filename,
      size: prepared.size,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Redeem: stream the finalized archive with its length; the staged
 * file is deleted when the stream closes, however it closes. */
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    const search = new URL(request.url).searchParams;
    const claimed = claimProjectExportTicket(
      scope, id,
      search.get("ticket") ?? "",
      search.get("key") ?? "",
    );
    if (!claimed) {
      throw new ApiError(
        "invalid_request",
        "This download is no longer available. Export again.",
        410,
      );
    }
    let handle;
    try {
      handle = (await openPrivateExport(scope, { path: claimed.path, cleanup: async () => claimed.settle() })).handle;
    } catch (e) {
      // The claim removed the entry and its expiry timer; a failed open
      // must still delete the staged file — nothing else
      // owns it any more.
      claimed.settle();
      throw e;
    }
    const stream = handle.createReadStream();
    stream.once("close", () => claimed.settle());
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(claimed.size),
        "content-disposition": `attachment; filename="${claimed.filename}"`,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
