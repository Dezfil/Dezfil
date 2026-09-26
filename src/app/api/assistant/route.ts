import { NextResponse } from "next/server";
import { currentAssistantChoices } from "@/lib/assistant/catalogue-choices";
import { describeModel } from "@/lib/assistant/model-knowledge";
import { limits } from "@/lib/limits";

/**
 * Assistant status: whether the assistant is enabled, and if not, the
 * documented enablement explanation. Never exposes the credential — only the
 * resolved provider/model when enabled.
 *
 * Adds what a person may choose: the allowed identities of the resolved
 * provider in the owner's order, each with its display name and the effort
 * levels that model offers. `model` keeps its meaning, the instance default,
 * and is always one of them. The read still holds no credential, constructs
 * no client and reaches no network.
 */
export async function GET() {
  const availability = currentAssistantChoices();
  if (!availability.enabled) {
    return NextResponse.json({
      enabled: false,
      reason: availability.reason,
    });
  }
  return NextResponse.json({
    enabled: true,
    provider: availability.provider,
    model: availability.model,
    models: availability.models.map((id) => describeModel(availability.provider, id, availability.knowledge)),
    catalogue: availability.catalogue,
    stepBudget: limits.assistantStepBudget,
    // The instance owner's setting, read here from the same limit the
    // loop consults, so a headless client and the pane learn it the same
    // way.
    autoCheck: limits.assistantAutoCheck,
  });
}
