import { limits } from "@/lib/limits";
import type { ToolDef } from "./tools";
import { toolRequest } from "./request";
import { validArguments } from "./validate";

/**
 * Execute a tool by calling the product's own documented HTTP API — tools
 * are clients of the same surface as the UI, never a backdoor. HTTP errors
 * come back as data (status + the API's coded error body), so agents
 * branch on error codes exactly like any scripted client.
 *
 * Attachment responses: a download endpoint answers with a
 * content-disposition attachment, and text-decoding those bytes would
 * corrupt every binary format. They arrive instead as one envelope —
 * filename, media type, size, base64 content — capped by a documented
 * limit so a huge export cannot flood the transport; over the cap the tool
 * answers with a coded error that says how to narrow it.
 */

export interface ToolResult {
  status: number;
  ok: boolean;
  body: unknown;
}

export interface AttachmentEnvelope {
  attachment: {
    filename: string;
    content_type: string;
    size_bytes: number;
    content_base64: string;
  };
}

function isAttachmentEnvelope(body: unknown): body is AttachmentEnvelope {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as AttachmentEnvelope).attachment === "object" &&
    (body as AttachmentEnvelope).attachment !== null &&
    typeof (body as AttachmentEnvelope).attachment.content_base64 === "string"
  );
}

/**
 * The model-context form of a tool result (assistant loop): attachment
 * bytes never enter model text — the envelope keeps its metadata and the
 * content is elided with a note. MCP clients get the full envelope.
 */
export function elideAttachment(body: unknown): unknown {
  if (!isAttachmentEnvelope(body)) return body;
  const { content_base64, ...meta } = body.attachment;
  void content_base64;
  return {
    ...body,
    attachment: {
      ...meta,
      content_base64:
        "(elided from conversation: the download completed; " +
        "the file is available through the UI or the API)",
    },
  };
}

function invalid(message: string): ToolResult {
  return {
    status: 400,
    ok: false,
    body: { error: { code: "invalid_request", message } },
  };
}

export async function executeTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  headers?: Record<string, string>,
  /** The originating caller's departure — forwarded to the internal
   * request so an aborted agent cancels its evaluation. */
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (!await validArguments(tool, args)) return invalid("The arguments do not match this operation’s input schema.");
  let request: ReturnType<typeof toolRequest>;
  try {
    request = toolRequest(tool, args, baseUrl, headers, signal);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Invalid tool arguments.");
  }
  const { url, init } = request;

  const res = await fetchImpl(url, init);
  // Only operations documented as bodyless use 204. Covered write results
  // carry their revision in JSON, preserved below for every tool consumer.
  if (res.status === 204) return { status: 204, ok: true, body: null };
  const contentType = res.headers.get("content-type") ?? "";
  const disposition = res.headers.get("content-disposition") ?? "";
  if (res.ok && disposition.includes("attachment")) {
    // The cap is enforced BEFORE buffering: a declared
    // length over it rejects without reading the body, and an undeclared
    // stream is counted chunk by chunk and abandoned the moment it
    // crosses — a multi-GB export must never materialize in this process
    // on its way to a 413.
    const cap = limits.toolAttachmentMaxBytes;
    // Recovery guidance follows what the tool actually produces
    // (review): an image shrinks by size, a data export by filtering.
    const remedy =
      tool.name === "export_map_image"
        ? "Reduce the image size (a smaller width preset)"
        : tool.name === "export_project"
          ? "Export fewer members (deselect large datasets)"
          : "Narrow the export (filter the layer)";
    const capError = (sizeText: string): ToolResult => ({
      status: 413,
      ok: false,
      body: {
        error: {
          code: "attachment_too_large",
          message:
            `The download is ${sizeText}, over the ` +
            `${Math.round(cap / 1024 / 1024)} MB tool-attachment limit. ` +
            `${remedy}, or raise DEZFIL_TOOL_ATTACHMENT_MAX_MB.`,
        },
      },
    });
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > cap) {
      await res.body?.cancel().catch(() => {});
      return capError(`${Math.round(declared / 1024 / 1024)} MB`);
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > cap) {
          await reader.cancel().catch(() => {});
          return capError(`over ${Math.round(cap / 1024 / 1024)} MB`);
        }
        chunks.push(value);
      }
    }
    const bytes = Buffer.concat(chunks);
    const filename =
      /filename="([^"]+)"/.exec(disposition)?.[1] ?? "download";
    const body: AttachmentEnvelope = {
      attachment: {
        filename,
        content_type: contentType,
        size_bytes: bytes.byteLength,
        content_base64: bytes.toString("base64"),
      },
    };
    return { status: res.status, ok: true, body };
  }
  const body = contentType.includes("application/json")
    ? await res.json()
    : await res.text();
  return { status: res.status, ok: res.ok, body };
}
