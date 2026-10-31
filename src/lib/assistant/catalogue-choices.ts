import { assistantAvailability, ownKeyAvailability } from "./config";
import { readModelCatalogue } from "./model-catalogue";

/** Only enabled status reads and new admissions need local knowledge.
 * Credentials and provider construction remain outside this snapshot. */
export function currentAssistantChoices() {
  const availability = assistantAvailability();
  if (!availability.enabled) return availability;
  const snapshot = readModelCatalogue();
  const current = assistantAvailability(process.env, snapshot.models);
  if (!current.enabled) return current;
  return { ...current, knowledge: snapshot.models, catalogue: snapshot.catalogue };
}

/** The same answer for the provider of a person's own key. */
export function ownKeyChoices(provider: string) {
  const snapshot = readModelCatalogue();
  return { ...ownKeyAvailability(provider, process.env, snapshot.models), knowledge: snapshot.models, catalogue: snapshot.catalogue };
}
