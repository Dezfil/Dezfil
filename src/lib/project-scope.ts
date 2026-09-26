import { ApiError } from "@/lib/api/errors";

/** The one project-context body field every creation road shares:
 * a string id, or null/omitted for unfiled. */
export function importProjectId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (raw === "") {
    throw new ApiError(
      "invalid_request",
      '"projectId" must be a project id, or null for unfiled.',
      400,
    );
  }
  if (typeof raw !== "string") {
    throw new ApiError(
      "invalid_request",
      '"projectId" must be a string or null.',
      400,
    );
  }
  return raw;
}

/** The listings' `?project=` scope: absent means
 * everything, an id means that project's members, `none` means the
 * unfiled. An empty value is a caller error, not a silent "all". */
export function projectScope(request: Request): string | "none" | undefined {
  const raw = new URL(request.url).searchParams.get("project");
  if (raw === null) return undefined;
  if (raw === "") {
    throw new ApiError(
      "invalid_request",
      '"project" must be a project id or "none" when given.',
      400,
    );
  }
  return raw === "none" ? "none" : raw;
}
