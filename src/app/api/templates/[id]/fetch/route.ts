import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { boundedBodyText } from "@/lib/api/bounded-body";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { fetchTemplate } from "@/lib/templates/download";
import { installRefusalError, TemplateRefusal } from "@/lib/templates/refusals";

const BODY_MAX_BYTES = 65_536;

/** The version a request names, or null for the one the card takes now. */
async function requestedVersion(request: Request): Promise<number | null> {
  const text = await boundedBodyText(request, BODY_MAX_BYTES);
  if (text.trim() === "") return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((k) => k !== "version")) {
    throw new ApiError("invalid_request", "The request body must be a JSON object with at most a version, or absent.", 400);
  }
  const { version } = body as { version?: unknown };
  if (version === undefined) return null;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new ApiError("invalid_request", '"version" must be a whole number from 1.', 400);
  }
  return version as number;
}

/** Download a template's version, once, and install it. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    const version = await requestedVersion(request);
    return privateResponse(NextResponse.json(await fetchTemplate(scope, id, version)));
  } catch (error) {
    return authFailure(error instanceof TemplateRefusal ? installRefusalError(error) : error);
  }
}
