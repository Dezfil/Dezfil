import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { accountScope } from "@/lib/auth/scope";
import { NextResponse } from "next/server";
import { currentAssistantChoices, ownKeyChoices } from "@/lib/assistant/catalogue-choices";
import { resolvePayer, type Payer } from "@/lib/assistant/keys/resolve";
import { describeModel } from "@/lib/assistant/model-knowledge";
import { limits } from "@/lib/limits";

/**
 * Assistant status, for the person asking: whether the assistant answers them,
 * on which provider and models, and whose key pays. Never exposes a credential:
 * a person's own key shows as its last four and the time it was saved. What the
 * server's variables should say is the System tab's, not this read's.
 *
 * Adds what a person may choose: the allowed identities of the provider in use
 * in the owner's order, each with its display name and the effort levels that
 * model offers. `model` is that provider's default and is always one of them.
 * The read constructs no client and reaches no network.
 */
export async function GET(request: Request) {
  try {
    const scope = accountScope(requireRequestAuth(request));
    return privateResponse(await status(resolvePayer(scope.accountId)));
  } catch (error) { return authFailure(error); }
}

async function status(payer: Payer) {
  if (payer.kind === "none") {
    return NextResponse.json({
      enabled: false,
      reason: payer.reason,
      instanceKey: false,
    });
  }
  const availability = payer.kind === "own" ? ownKeyChoices(payer.provider) : currentAssistantChoices();
  if (!availability.enabled) return NextResponse.json({ enabled: false, reason: availability.reason, instanceKey: false });
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
    payer: payer.kind === "own" ? { kind: "own", ...payer.facts } : { kind: "instance", provider: payer.provider },
    instanceKey: payer.instanceKey,
    ...(payer.kind === "instance" && payer.unreadable ? { unreadableKey: true } : {}),
  });
}
