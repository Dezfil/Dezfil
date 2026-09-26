import { assistantAvailability } from "./config";
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
