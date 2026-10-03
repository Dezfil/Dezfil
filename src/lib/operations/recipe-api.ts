import type { DocumentFacts } from "@/lib/metadata/document-facts";
import type { AccountScope } from "@/lib/auth/scope";
import { ApiError } from "@/lib/api/errors";
import { WORKFLOW_JSON_BODY_MAX_BYTES } from "@/lib/api/request-bounds";
import { getLayer } from "@/lib/metadata/map-queries";
import { requireReachable } from "@/lib/auth/reach";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import type { RecipeOrigin } from "@/lib/metadata/recipes";
import type { CascadeRun } from "@/lib/metadata/cascades";
import { jobView } from "./job-view";
import type { CascadeView } from "./cascade";
import { captureFromLayer } from "./step-origin";
import type { ReaderContext, RecipeView, StepView } from "./recipe-view";
import { summaryFor } from "./summary";

/**
 * What the recipe routes put on the wire.
 *
 * Shaping lives here rather than in each handler so the same step is described
 * identically wherever it appears — inside a recipe, on its own, and after a
 * run. Three fields carry more than their size suggests.
 *
 * **`conditions` is a list, and `condition` is only its first.** A step can be
 * broken *and* missing its output; a surface that read one word would have to
 * choose, and the API must not choose for it.
 *
 * **`latestAttempt` is a job, and is not the condition.** *Fresh output, latest
 * attempt failed* is an ordinary situation, and reading either alone
 * misdescribes it.
 *
 * **`substitutionNote` is said, not implied.** A step authored from an
 * aggregated layer runs on the rows behind the cells, and the API says so in as
 * many words rather than leaving it to be discovered.
 *
 * **`summary` is one sentence, composed here**. The phase's amendment A1 traded
 * the plain-sentence parameter form for a labelled grid and named this as the
 * compensation, binding: the API, the drawer and any agent read the same
 * sentence, untruncated, rather than each composing its own and drifting
 * invisibly.
 */

/** A captured layer's origin as its reader may see it: the identity of a map
 * and layer the reader does not reach is left out, the rest stays. */
function originFor(origin: Record<string, unknown> | null, context: ReaderContext): Record<string, unknown> | null {
  if (!origin || typeof origin.mapId !== "string" || context.reachesMap(origin.mapId)) return origin;
  const bounded = { ...origin };
  delete bounded.mapId;
  delete bounded.layerId;
  delete bounded.layerName;
  return bounded;
}

/** Everything is the reader's to see when no reader context is given. */
const AS_STORED: ReaderContext = { link: (link) => link, reachesMap: () => true };

export function stepPayload(view: StepView & { context?: ReaderContext; facts?: DocumentFacts }, context: ReaderContext = view.context ?? AS_STORED) {
  const { step, condition, latestAttempt, edges, reads } = view;
  const attempt = latestAttempt ? jobView(latestAttempt) : null;
  if (attempt) {
    const output = context.link(attempt.output ?? null);
    if (output) attempt.output = output;
    else { delete attempt.output; delete attempt.disclosure; }
  }
  return {
    ...view.facts,
    id: step.id,
    recipeId: step.recipeId,
    ordinal: step.ordinal,
    operation: step.operation,
    parameters: step.parameters,
    // What the step means **now**: a proposal is described where it can be
    // labelled as pending, not folded into the sentence for what ran.
    summary: summaryFor(step.operation, step.parameters),
    proposedParameters: step.proposedParameters,
    // The output of the run this view describes, naming its runner and run.
    output: view.output !== undefined
      ? view.output
      : context.link(step.outputTableId ? { id: step.outputTableId, name: step.outputTableName ?? "" } : null),
    condition: condition.primary,
    conditions: condition.conditions,
    causes: condition.causes,
    missingInputs: condition.missingInputs,
    origin: originFor(step.origin, context),
    inputs: edges.map((e) => ({ id: e.inputTableId, name: e.inputTableName })),
    // What it would read next — the pending definition's when one is held.
    // Present tense beside `inputs`' past tense.
    reads,
    latestAttempt: attempt,
    lastSuccessAt: step.lastSuccessAt,
  };
}

export function recipePayload(view: RecipeView) {
  return {
    ...view.facts,
    id: view.recipe.id,
    name: view.recipe.name,
    origin: view.recipe.origin,
    // The project only when the reader reaches it.
    projectId: view.presence.projectId,
    owner: view.presence.owner,
    home: view.presence.home,
    createdAt: view.recipe.createdAt,
    updatedAt: view.recipe.updatedAt,
    summary: view.summary,
    steps: view.steps.map((step) => stepPayload({ ...step, facts: view.facts }, view.context)),
  };
}

export function cascadePayload(cascade: CascadeView | CascadeRun) {
  return {
    id: cascade.id,
    recipeId: cascade.recipeId,
    kind: cascade.kind,
    outcome: cascade.outcome,
    cancelled: cascade.cancelled,
    startedAt: cascade.startedAt,
    finishedAt: cascade.finishedAt,
    members: cascade.members,
    ...("outputs" in cascade ? { outputs: cascade.outputs } : {}),
    ...("runner" in cascade ? { runner: cascade.runner } : {}),
  };
}

/**
 * Resolve what a step authored from a layer will consume.
 *
 * The capture happens **here, once**, at the moment the step is created: the
 * stored SQL is a snapshot, so a later edit to the layer's filters does not
 * follow it. Reading the layer again at run time is the one implementation this
 * must not be.
 */
export function captureLayerSource(scope: AccountScope, layerId: string): {
  sql: string;
  origin: Record<string, unknown>;
} {
  // Any layer the caller reaches; the SQL as written in its map's home.
  requireReachable(scope, "layer", layerId);
  const layer = getLayer(layerId);
  if (!layer) throw resourceAbsent();
  const captured = captureFromLayer({
    id: layer.id,
    mapId: layer.mapId,
    name: layer.name,
    sql: layer.sql,
    filters: layer.filters ?? [],
    viz: layer.viz,
  });
  return {
    sql: captured.sql,
    origin: captured.origin as unknown as Record<string, unknown>,
  };
}

const bodyTooLarge = (): ApiError =>
  new ApiError(
    "request_body_too_large",
    `The workflow request body exceeds the ${WORKFLOW_JSON_BODY_MAX_BYTES}-byte limit.`,
    413,
  );

async function boundedBodyText(request: Request): Promise<string> {
  const declared = request.headers.get("content-length")?.trim();
  if (declared && /^\d+$/.test(declared)) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes > WORKFLOW_JSON_BODY_MAX_BYTES) {
      throw bodyTooLarge();
    }
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > WORKFLOW_JSON_BODY_MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The refusal is authoritative even if the producer cannot be cancelled.
      }
      throw bodyTooLarge();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

/** Read a JSON object body, refusing anything else with the documented code. */
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await boundedBodyText(request));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "invalid_request",
      "The request body must be a JSON object.",
      400,
    );
  }
}

/**
 * Read an *optional* JSON object body — absent means absent, malformed is a
 * refusal.
 *
 * The difference matters wherever an absent body selects a default with a
 * wider blast radius than the value it defaults from. Swallowing a parse
 * failure into `{}` there means a truncated request quietly asks for more than
 * the caller wrote.
 */
export async function optionalJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const text = await boundedBodyText(request);
    if (text.trim() === "") return {};
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "invalid_request",
      "The request body must be a JSON object, or absent.",
      400,
    );
  }
}

/** A recipe's name: trimmed, non-empty, at most this
 * many characters; two recipes may share one, as two maps may. The stored name
 * is the trimmed one — create and rename both come through here. */
export const RECIPE_NAME_MAX = 120;

export function recipeName(body: Record<string, unknown>): string {
  const raw = body.name;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ApiError("invalid_request", '"name" must be a non-empty string.', 400);
  }
  const name = raw.trim();
  if (name.length > RECIPE_NAME_MAX) {
    throw new ApiError(
      "invalid_request",
      `"name" must be at most ${RECIPE_NAME_MAX} characters.`,
      400,
    );
  }
  return name;
}

/** The surface creating a recipe: omitted means a
 * workflow; the builder's one-step Tools say so. Fixed at creation. */
export function recipeOrigin(body: Record<string, unknown>): RecipeOrigin {
  const raw = body.origin;
  if (raw === undefined || raw === null) return "workflow";
  if (raw === "workflow" || raw === "builder") return raw;
  throw new ApiError(
    "invalid_request",
    '"origin" must be "workflow" or "builder" when given.',
    400,
  );
}

export function requireString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(
      "invalid_request",
      `"${field}" must be a non-empty string.`,
      400,
    );
  }
  return value;
}
