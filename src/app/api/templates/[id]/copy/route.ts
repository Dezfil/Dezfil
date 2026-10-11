import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { boundedBodyText } from "@/lib/api/bounded-body";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { copyTemplate, type CopyRequest } from "@/lib/templates/copy";
import { isTemplateVersion } from "@/lib/templates/ids";
import { installRefusalError, TemplateRefusal } from "@/lib/templates/refusals";

const BODY_MAX_BYTES = 65_536;

/** The name and the version a request names, each optional. */
async function copyRequest(request: Request): Promise<CopyRequest> {
  const text = await boundedBodyText(request, BODY_MAX_BYTES);
  if (text.trim() === "") return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((k) => k !== "name" && k !== "version")) {
    throw new ApiError("invalid_request", "The request body must be a JSON object with at most a name and a version, or absent.", 400);
  }
  const { name, version } = body as { name?: unknown; version?: unknown };
  if (name !== undefined && typeof name !== "string") throw new ApiError("invalid_request", '"name" must be a string.', 400);
  if (version !== undefined && !isTemplateVersion(version)) {
    throw new ApiError("invalid_request", '"version" must be a whole number from 1.', 400);
  }
  return { ...(name === undefined ? {} : { name }), ...(version === undefined ? {} : { version: version as number }) };
}

/** Make a copy of a template's installed version into a new project. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    const copy = await copyTemplate(scope, id, await copyRequest(request));
    return privateResponse(NextResponse.json(copy, { status: 201, headers: { Location: `/api/projects/${copy.project.id}` } }));
  } catch (error) {
    return authFailure(error instanceof TemplateRefusal ? installRefusalError(error) : error);
  }
}
