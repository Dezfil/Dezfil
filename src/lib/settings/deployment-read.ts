import { existsSync } from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/config";
import { sessionCookieName } from "@/lib/auth/session-cookie";
import { assistantAvailability, allowedModels, DEFAULT_MODELS } from "@/lib/assistant/config";
import { readModelCatalogue } from "@/lib/assistant/model-catalogue";
import { defaultOfferMode } from "@/lib/assistant/offer";
import { discloseAddress, isWebAddress, refusesUserInformation, variableMayNameFolder } from "./disclosure";
import { settingEnvironment } from "./resolver";
import type { SettingDefinition } from "./types";

/** Inspect configuration only. In particular, never call the key accessor or a provider. */
export function readDeploymentSetting(definition: SettingDefinition) {
  const raw = settingEnvironment(definition);
  const modelList = definition.key === "aiModelsAnthropic" || definition.key === "aiModelsOpenai";
  const locked = modelList ? raw !== undefined : raw !== undefined && raw !== "";
  let value: unknown = locked ? raw : definition.defaultValue;
  let invalidOverride = false;
  if (definition.secret) {
    value = definition.key === "secretKey"
      ? { status: locked ? "environment" : existsSync(path.join(dataDir(), "secret.key")) ? "data-directory" : "not-yet-present" }
      : { set: locked };
  } else if (definition.kind === "address") {
    // A folder the variable names is said to be one, never where it is.
    value = locked && variableMayNameFolder(definition) && !isWebAddress(raw!) ? { set: true, folder: true }
      : typeof value === "string" || value === null ? discloseAddress(value, refusesUserInformation(definition)) : value;
  } else if (definition.key === "dataDir") value = dataDir();
  else if (definition.key === "sessionCookie") value = sessionCookieName();
  else if (definition.key === "assistantAutoCheck") value = !locked || !["0", "false", "off"].includes(raw!.trim().toLowerCase());
  else if (definition.key === "objectStoreCredentials") value = ["1", "true", "yes"].includes(raw?.toLowerCase() ?? "");
  else if (definition.key === "assistantOffer") {
    value = defaultOfferMode();
    invalidOverride = locked && raw !== "full" && raw !== "subset";
  } else if (definition.key === "aiProvider" || definition.key === "aiModel") {
    const assistant = assistantAvailability();
    value = assistant.enabled ? definition.key === "aiProvider" ? assistant.provider : assistant.model : null;
    invalidOverride = locked && !assistant.enabled;
  } else if (modelList) {
    const provider = definition.key === "aiModelsAnthropic" ? "anthropic" : "openai";
    const model = settingEnvironment({ ...definition, environment: "DEZFIL_AI_MODEL" }) ?? DEFAULT_MODELS[provider];
    value = allowedModels(process.env, provider, model, readModelCatalogue().models);
  } else if (definition.kind === "list") value = raw?.split(definition.key === "trustedProxies" ? /[\s,]+/ : /,/).map(item => item.trim()).filter(Boolean) ?? [];
  return { value, source: locked && !invalidOverride ? "environment" as const : "default" as const,
    locked, invalidOverride, storedValue: null };
}
