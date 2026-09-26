import { ApiError } from "@/lib/api/errors";
import { parseGeometryChoice } from "./choice";

export function requiredGeometryRevision(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new ApiError("invalid_request", "An expectedRevision from geometry inspection is required.", 400);
  return value;
}
export async function geometryRequest(request: Request) {
  const body: unknown = await request.json().catch(() => { throw new ApiError("invalid_request", "Send a JSON object with expectedRevision and choice.", 400); });
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["expectedRevision", "choice"].includes(k))) {
    throw new ApiError("invalid_request", "Send only expectedRevision and choice in a JSON object.", 400);
  }
  const b = body as Record<string, unknown>;
  return { expectedRevision: requiredGeometryRevision(b.expectedRevision), choice: parseGeometryChoice(b.choice) };
}
export function geometryQuery(request: Request, allowed: string[]) {
  const query = new URL(request.url).searchParams;
  for (const key of query.keys()) {
    if (!allowed.includes(key) || query.getAll(key).length > 1) throw new ApiError("invalid_request", `Unexpected or repeated query parameter "${key}".`, 400);
  }
  return query;
}
