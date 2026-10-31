import { NextResponse } from "next/server";
import { requireCurrentActor } from "@/lib/auth/credentials";
import { AuthError } from "@/lib/auth/errors";
import { authBody, authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { removeOwnKey, setOwnKey } from "@/lib/assistant/keys/change";
import { assistantKeyFacts, cleanKey, isKeyProvider, KEY_MAX_LENGTH, KEY_MIN_LENGTH, readAssistantKey } from "@/lib/assistant/keys/store";

/**
 * One's own key and nobody else's: the account comes from the credential alone,
 * and the body names only a provider and the key. Every refusal here is a fixed
 * sentence, so what was typed is never said back.
 */
const INVALID_KEY = `Choose Anthropic or OpenAI and enter a key of ${KEY_MIN_LENGTH} to ${KEY_MAX_LENGTH} characters with no spaces.`;

function keyStatus(accountId: string) {
  return { key: assistantKeyFacts(accountId), unreadable: readAssistantKey(accountId) === "unreadable" };
}

export async function GET(request: Request) {
  try {
    const account = requireCurrentActor(requireRequestAuth(request));
    return privateResponse(NextResponse.json(keyStatus(account.id)));
  } catch (error) { return authFailure(error); }
}

export async function PUT(request: Request) {
  try {
    const context = requireRequestAuth(request);
    const account = requireCurrentActor(context);
    const body = await authBody(request, ["provider", "key"]);
    const key = cleanKey(body.key);
    if (!isKeyProvider(body.provider) || key === null) throw new AuthError("invalid_request", INVALID_KEY, 400);
    // A body can take its time, and the credential can be revoked meanwhile.
    requireCurrentActor(context);
    setOwnKey(account.id, body.provider, key);
    return privateResponse(NextResponse.json(keyStatus(account.id)));
  } catch (error) { return authFailure(error); }
}

export async function DELETE(request: Request) {
  try {
    const account = requireCurrentActor(requireRequestAuth(request));
    return privateResponse(NextResponse.json({ removed: removeOwnKey(account.id) }));
  } catch (error) { return authFailure(error); }
}
