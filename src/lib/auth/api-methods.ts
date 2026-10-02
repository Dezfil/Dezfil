import { NextResponse } from "next/server";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";

/** A derived dispatch table, never a second manually maintained route inventory. */
export function deriveApiMethods(paths: Record<string, object>) {
  return Object.entries(paths).map(([template, operations]) => ({
    template,
    matcher: new RegExp("^" + template.split("/").map(segment => /^\{[^}]+\}$/.test(segment)
      ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/") + "$"),
    methods: Object.keys(operations).map(method => method.toUpperCase()).sort(),
  })).sort((a, b) => (a.template.match(/\{/g)?.length ?? 0) - (b.template.match(/\{/g)?.length ?? 0));
}
export const apiMethodTable = deriveApiMethods(buildOpenApiDocument().paths);

/** Called only after the entry/authentication boundary has admitted the request. */
export function apiMethodResponse(pathname: string, method: string): NextResponse | null {
  const entry = apiMethodTable.find(candidate => candidate.matcher.test(pathname));
  if (!entry) return null; // Let the framework keep its unmatched API 404.
  const headers = { Allow: entry.methods.join(", ") };
  if (method === "OPTIONS") return new NextResponse(null, { status: 204, headers });
  if (entry.methods.includes(method)) return null;
  if (method === "HEAD") return new NextResponse(null, { status: 405, headers });
  const response = errorResponse(new ApiError("method_not_allowed", ERROR_CATALOGUE.method_not_allowed, 405));
  response.headers.set("Allow", headers.Allow);
  return response;
}
