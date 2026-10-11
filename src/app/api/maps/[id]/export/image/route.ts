import { largeJsonValue } from "@/lib/api/json-body";
import { delegateCredential } from "@/lib/auth/delegation";
import { accountScope } from "@/lib/auth/scope";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { requireMap } from "@/lib/map-access";
import {
  EXPORT_IMAGE_DEFINITION_SCHEMA,
  definitionRenderProblems,
  type ExportImageDefinition,
} from "@/lib/export/image-definition";
import { validateAgainstSchema } from "@/lib/export/schema-validate";
import { renderMapImage } from "@/lib/export/render-image";
import { requireRenderStanding } from "@/lib/export/render-standing";
import { selfBaseUrl } from "@/lib/self-url";

type Params = { params: Promise<{ id: string }> };

/** A content-disposition-safe download name from the free-text map name. */
function pngFilename(name: string): string {
  const base = name
    .replace(/[^A-Za-z0-9._ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${base || "map"}.png`;
}

/**
 * Render a map to PNG: the moment image export becomes an agent
 * capability. Validates the definition against the documented schema
 * itself, renders through the bounded browser lane, and answers the
 * exact-size PNG as an attachment with a declared length — the tool
 * transport's envelope carries it to agents byte-for-byte.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const actor = requireRequestAuth(request);
    const { id } = await params;
    const scope = accountScope(actor);
    const map = requireMap(scope, id);
    // The render's own standing, asked before the body: a map the render
    // cannot stand on (a template's, opened only to view) is absent here.
    requireRenderStanding(scope, id);
    let body: unknown;
    try {
      body = await largeJsonValue(request);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    const definition = (body as { definition?: unknown })?.definition;
    const problems = validateAgainstSchema(
      definition,
      EXPORT_IMAGE_DEFINITION_SCHEMA,
    );
    const renderProblems =
      problems.length > 0
        ? problems
        : definitionRenderProblems(definition as ExportImageDefinition);
    if (renderProblems.length > 0) {
      throw new ApiError(
        "invalid_request",
        `The export definition is invalid: ${renderProblems[0]}.`,
        400,
      );
    }
    const { png, abandoned } = await renderMapImage(scope, {
      mapId: id,
      definition: definition as ExportImageDefinition,
      baseUrl: selfBaseUrl(request),
      credential: delegateCredential(actor),
      signal: request.signal,
      standing: () => requireRenderStanding(scope, id),
    });
    requireRenderStanding(scope, id);
    const headers: Record<string, string> = {
      "content-type": "image/png",
      "content-length": String(png.byteLength),
      "content-disposition": `attachment; filename="${pngFilename(map.name)}"`,
    };
    if (abandoned.length > 0) {
      // Said, never silent: the count and the hosts on the answer
      // (hosts only, never a path); the renderer's own log line named
      // the abandonment at the moment it happened.
      headers["x-dezfil-export-abandoned"] =
        `${abandoned.length}; hosts=${[...new Set(abandoned)].join(",")}`;
    }
    return privateResponse(new NextResponse(Buffer.from(png), { headers }));
  } catch (error) {
    return authFailure(error);
  }
}
