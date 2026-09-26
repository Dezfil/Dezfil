import { ApiError } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { PROVIDER_DEFAULT_EFFORT, describeModel, type ModelCatalogue } from "./model-knowledge";

/**
 * The optional choice a message request may carry: a model, an effort, or
 * both. It lives in its own module rather than in the route because the
 * route already carries the run's lifecycle, and because a first
 * submission's choice must be resolved and judged before the run binds.
 *
 * Resolution rules: an omitted model is the instance default; an omitted
 * effort is the model's own provider-default entry; and an empty
 * choice — absent, `{}`, or fields that are empty once trimmed — is
 * equivalent to omission. What a level means on the wire stays each
 * adapter's own business.
 *
 * The four refusals are here too, each with its own documented code, and
 * each raised before the run binds so a refused first submission spends
 * nothing. Every message says what would be accepted instead and
 * where to read it: the phase rule is that an agent which would need a
 * warning gets a better API answer instead.
 */

export type ResolvedChoice = {
  /** The identity the request will be sent to. */
  model: string;
  /** A provider's own level word, or the provider-default entry. */
  effort: string;
  /** Which halves the instance supplied rather than the person:
   * the record distinguishes requested from defaulted. */
  defaulted: { model: boolean; effort: boolean };
};

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const malformed = (detail: string): never => {
  throw new ApiError("assistant_choice_invalid", `${ERROR_CATALOGUE.assistant_choice_invalid} ${detail}`, 400);
};

/**
 * What the client actually asked for, with empties read as omissions and
 * anything that is not a choice refused rather than quietly ignored — a
 * silently dropped setting is worse than a refusal, because the answer
 * then comes from a model the person did not pick.
 */
export function requestedChoice(raw: unknown): { model?: string; effort?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) malformed(`Received ${Array.isArray(raw) ? "an array" : `a ${typeof raw}`}.`);
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "model" && key !== "effort");
  if (unknown.length > 0) malformed(`Unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`);
  for (const key of ["model", "effort"] as const) {
    if (key in record && record[key] !== undefined && typeof record[key] !== "string") malformed(`The "${key}" field is a ${typeof record[key]}.`);
  }
  const { model, effort } = record as { model?: string; effort?: string };
  return { ...(text(model) ? { model: text(model) } : {}), ...(text(effort) ? { effort: text(effort) } : {}) };
}

/** What the instance offers, as the status read reports it. */
export type InstanceChoices = { provider: string; model: string; models: string[]; knowledge: ModelCatalogue };

/**
 * Resolve the request's choice and judge it against what this instance
 * offers. Listing an identity grants permission to request it; whether the
 * provider actually has it is the provider's own answer, and a rejection
 * there stays a provider failure rather than one of ours.
 */
export function chooseForRequest(raw: unknown, instance: InstanceChoices): ResolvedChoice {
  const requested = requestedChoice(raw);
  if (requested.model !== undefined && !instance.models.includes(requested.model)) {
    throw new ApiError(
      "assistant_model_not_offered",
      `This instance does not offer the model "${requested.model}". It offers: ${instance.models.join(", ")}. ${ERROR_CATALOGUE.assistant_model_not_offered}`,
      400,
    );
  }
  const model = requested.model ?? instance.model;
  if (requested.effort !== undefined) {
    const offered = describeModel(instance.provider, model, instance.knowledge).efforts;
    if (!offered.some((e) => e.value === requested.effort)) {
      // Two refusals, kept apart because they tell the requester different
      // things. A model with no levels of its own takes the provider
      // default and nothing else, so *any* named level is the unsupported
      // case and the message names the one value it does take. A model with
      // levels refuses the particular word and lists the ones it has.
      const levels = offered.filter((e) => e.value !== PROVIDER_DEFAULT_EFFORT);
      if (levels.length === 0) {
        throw new ApiError(
          "assistant_effort_not_supported",
          `The model "${model}" takes only "${PROVIDER_DEFAULT_EFFORT}", the provider's own setting. ${ERROR_CATALOGUE.assistant_effort_not_supported}`,
          400,
        );
      }
      throw new ApiError(
        "assistant_effort_not_offered",
        `The model "${model}" does not offer the effort "${requested.effort}". It offers: ${offered.map((e) => e.value).join(", ")}. ${ERROR_CATALOGUE.assistant_effort_not_offered}`,
        400,
      );
    }
  }
  return resolveChoice(raw, instance.model);
}

/** The pair the adapter will be built for, against the instance default. */
export function resolveChoice(raw: unknown, instanceDefault: string): ResolvedChoice {
  const requested = requestedChoice(raw);
  return {
    model: requested.model ?? instanceDefault,
    effort: requested.effort ?? PROVIDER_DEFAULT_EFFORT,
    defaulted: { model: requested.model === undefined, effort: requested.effort === undefined },
  };
}
