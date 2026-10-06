import shipped from "./model-catalogue.json";
import type { ModelCatalogue } from "./model-knowledge";

/**
 * Assistant enablement (Model access): bring-your-own API key, one administrator-level credential
 * per instance. With no credential the instance is a complete product and the assistant surface
 * is absent — `reason` carries the documented enablement explanation.
 *
 * Adds what the instance *allows a person to choose*: a list per provider, of which only the
 * resolved provider's applies, always carrying the instance default exactly once. An unset list
 * offers the catalogue; a set list narrows and orders it.
 */

export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5.6-terra",
};

const KEY_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** Where an instance owner names the models a person may choose, per
 * provider. Only the resolved provider's list is read. */
const MODEL_LIST_VARS: Record<string, string> = {
  anthropic: "DEZFIL_AI_MODELS_ANTHROPIC",
  openai: "DEZFIL_AI_MODELS_OPENAI",
};

export type AssistantAvailability =
  | { enabled: true; provider: string; model: string; models: string[] }
  | { enabled: false; reason: string };

const ENABLE_HINT =
  "Set ANTHROPIC_API_KEY or OPENAI_API_KEY (optionally DEZFIL_AI_PROVIDER " +
  "and DEZFIL_AI_MODEL) and restart to enable the assistant.";

/**
 * The identities this instance offers for one provider: the owner's list in the owner's order,
 * each identity once, with the instance default present whether or not they named it. An unset
 * list uses the catalogue; a set list of nothing but separators leaves the default alone.
 */
export function allowedModels(
  env: Record<string, string | undefined>,
  provider: string,
  defaultModel: string,
  catalogue: ModelCatalogue = shipped,
): string[] {
  const list = env[MODEL_LIST_VARS[provider]];
  const named = list === undefined
    ? (catalogue[provider as keyof ModelCatalogue] ?? []).map((entry) => entry.id)
    : list.split(",").map((identity) => identity.trim()).filter(Boolean);
  const models = named.includes(defaultModel) ? named : [defaultModel, ...named];
  return [...new Set(models)];
}

export function assistantAvailability(
  env: Record<string, string | undefined> = process.env,
  catalogue: ModelCatalogue = shipped,
): AssistantAvailability {
  const forced = env.DEZFIL_AI_PROVIDER?.toLowerCase();
  if (forced && !(forced in KEY_VARS)) {
    return {
      enabled: false,
      reason:
        `Unknown DEZFIL_AI_PROVIDER "${forced}". Supported providers are ` +
        `${Object.keys(KEY_VARS).join(" and ")}. ${ENABLE_HINT}`,
    };
  }

  const withKey = Object.keys(KEY_VARS).filter((p) => env[KEY_VARS[p]]);
  const provider = forced ?? withKey[0];
  if (!provider || !env[KEY_VARS[provider]]) {
    const reason = forced
      ? `DEZFIL_AI_PROVIDER is "${forced}" but ${KEY_VARS[forced]} is not set. ${ENABLE_HINT}`
      : `No model credential is configured. ${ENABLE_HINT}`;
    return { enabled: false, reason };
  }

  const model = env.DEZFIL_AI_MODEL ?? DEFAULT_MODELS[provider];
  return {
    enabled: true,
    provider,
    model,
    models: allowedModels(env, provider, model, catalogue),
  };
}
