import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import {
  displayName,
  instanceName,
  mergeViewPrefs,
  setDisplayName,
  setInstanceName,
  viewPrefs,
  type ScreenPrefs,
  type ViewPrefs,
} from "@/lib/metadata/settings";

const NAME_MAX = 80;

const SCREEN_SORTS: Record<keyof ViewPrefs, string[]> = {
  maps: ["edited", "created", "name"],
  data: ["updated", "name", "rows", "size"],
  workflows: ["edited", "created", "name"],
  projects: ["updated", "name", "largest"],
};

/** Accept only the documented shape: per-screen view/sort. */
function normalizeViewPrefs(input: unknown): ViewPrefs {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApiError(
      "invalid_request",
      'viewPrefs must be an object like { maps: { view, sort }, data: …, workflows: …, projects: … }.',
      400,
    );
  }
  const out: ViewPrefs = {};
  for (const screen of ["maps", "data", "workflows", "projects"] as const) {
    const slice = (input as Record<string, unknown>)[screen];
    if (slice === undefined) continue;
    if (typeof slice !== "object" || slice === null || Array.isArray(slice)) {
      throw new ApiError(
        "invalid_request",
        `viewPrefs.${screen} must be an object.`,
        400,
      );
    }
    const { view, sort } = slice as Record<string, unknown>;
    const normalized: ScreenPrefs = {};
    if (view !== undefined) {
      if (view !== "grid" && view !== "list") {
        throw new ApiError(
          "invalid_request",
          `viewPrefs.${screen}.view must be "grid" or "list".`,
          400,
        );
      }
      normalized.view = view;
    }
    if (sort !== undefined) {
      if (
        typeof sort !== "string" ||
        !SCREEN_SORTS[screen].includes(sort)
      ) {
        throw new ApiError(
          "invalid_request",
          `viewPrefs.${screen}.sort must be one of ${SCREEN_SORTS[screen].join(", ")}.`,
          400,
        );
      }
      normalized.sort = sort;
    }
    out[screen] = normalized;
  }
  return out;
}

/** Workspace settings — single-user preferences. */
export async function GET() {
  try {
    return NextResponse.json({
      displayName: displayName(),
      instanceName: instanceName(),
      viewPrefs: viewPrefs(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Update workspace settings. Only known keys are accepted. */
export async function PATCH(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      displayName?: unknown;
      instanceName?: unknown;
      viewPrefs?: unknown;
    } | null;
    if (!body) {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    if (body.displayName !== undefined) {
      if (
        typeof body.displayName !== "string" ||
        !body.displayName.trim() ||
        body.displayName.trim().length > NAME_MAX
      ) {
        throw new ApiError(
          "invalid_request",
          `"displayName" must be a non-empty string of at most ${NAME_MAX} characters.`,
          400,
        );
      }
      setDisplayName(body.displayName.trim());
    }
    if (body.instanceName !== undefined) {
      // The one departure from the display-name contract: the name is
      // optional, so empty or whitespace CLEARS it — and so does an
      // explicit null.
      if (body.instanceName !== null && typeof body.instanceName !== "string") {
        throw new ApiError(
          "invalid_request",
          '"instanceName" must be a string, or null to clear it.',
          400,
        );
      }
      const trimmed =
        typeof body.instanceName === "string" ? body.instanceName.trim() : "";
      if (trimmed.length > NAME_MAX) {
        throw new ApiError(
          "invalid_request",
          `"instanceName" must be at most ${NAME_MAX} characters.`,
          400,
        );
      }
      setInstanceName(trimmed === "" ? null : trimmed);
    }
    if (body.viewPrefs !== undefined) {
      mergeViewPrefs(normalizeViewPrefs(body.viewPrefs));
    }
    return NextResponse.json({
      displayName: displayName(),
      instanceName: instanceName(),
      viewPrefs: viewPrefs(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
