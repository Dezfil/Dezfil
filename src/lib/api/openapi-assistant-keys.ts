import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op } from "./openapi-helpers";
import { LOCAL_DELETE, LOCAL_READ, LOCAL_REPLACE } from "./operation-mcp";
import { keptFromAssistant, READ_ONLY, resource, writes } from "./operation-metadata";
import { KEY_MAX_LENGTH, KEY_MIN_LENGTH, KEY_PROVIDERS } from "@/lib/assistant/keys/store";

const privacy = "Your own key and nobody else's: the account comes from the credential alone, and no operation reads or changes another person's key, an admin's included. Cookie or bearer authentication is required. Cookie mutations require the same trusted Origin. Responses, including refusals, are private, no-store. ";
const kept = "An MCP client or a script may call this; the in-app assistant is neither offered it nor admitted to it, on any page. ";
const errors = { "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "503": ERROR_RESPONSE };
const ownSubject = { path: "/api/account", argument: "", name: "account.name" };

export const ASSISTANT_KEY_PATHS = {
  "/api/account/assistant-key": {
    get: { ...op({ summary: "Read your AI key's status", description: privacy + kept + "Says which provider your key is for, its last four characters and when it was saved. `key` is null when you have none. `unreadable` is true when a saved key can no longer be opened, for example after the instance's encryption key changed: it counts as none and is added again. The key itself is never returned.",
      tag: "Accounts", tool: "get_assistant_key", effects: keptFromAssistant(READ_ONLY), mcp: LOCAL_READ, display: { verb: "Read your AI key's status" },
      responses: { "200": jsonOk("#/components/schemas/AssistantKeyStatus"), ...errors } }), security: AUTH_SECURITY },
    put: { ...op({ summary: "Set or replace your AI key", description: privacy + kept + `Saves your own Anthropic or OpenAI key, encrypted, in place of any you had; the assistant then answers you on it, sending it only to that provider's public address. The key is taken trimmed and needs ${KEY_MIN_LENGTH} to ${KEY_MAX_LENGTH} characters with no whitespace or control characters inside; anything else returns invalid_request, which never repeats what was sent, and the previous key stays. Saving makes no provider call: the first turn is the check. Replacing a key ends your turns begun before it, running and parked, as a cancel does; a later resolution of a parked one returns assistant_key_changed. Adding a first key ends nothing.`,
      tag: "Accounts", tool: "set_assistant_key", effects: keptFromAssistant(writes(resource("accounts"))), mcp: LOCAL_REPLACE, display: { verb: "Saved your AI key" },
      requestBody: { "x-byte-limit": 65_536, required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false,
        properties: { provider: { type: "string", enum: [...KEY_PROVIDERS], description: "The provider the key belongs to." },
          key: { type: "string", writeOnly: true, description: "The key. Write-only: no answer returns it." } }, required: ["provider", "key"] } } } },
      responses: { "200": jsonOk("#/components/schemas/AssistantKeyStatus"), ...errors } }), security: AUTH_SECURITY },
    delete: { ...op({ summary: "Remove your AI key", description: privacy + kept + "Removes your own key and ends your turns begun before it, running and parked, as a cancel does; a later resolution of a parked one returns assistant_key_changed. The assistant then answers you on the instance's key if it has one, and otherwise refuses until you add another. `removed` is false when there was none, so removing twice is harmless.",
      tag: "Accounts", tool: "remove_assistant_key", effects: keptFromAssistant(writes(resource("accounts"))), mcp: LOCAL_DELETE, display: { verb: "Removed your AI key" }, confirm: true,
      confirmation: { target: "Remove your AI key?", consequence: "Turns in progress stop. The assistant then uses the instance's key for you if it has one, and otherwise stops answering you until you add another.", subject: ownSubject },
      responses: { "200": jsonOk("#/components/schemas/AssistantKeyRemoved"), ...errors } }), security: AUTH_SECURITY },
  },
};

const facts = { provider: { type: "string", enum: [...KEY_PROVIDERS] }, lastFour: { type: "string", minLength: 4, maxLength: 4, description: "The key's last four characters." },
  savedAt: { type: "string", format: "date-time", description: "When it was saved." } };
export const ASSISTANT_KEY_SCHEMAS = {
  AssistantKeyStatus: { type: "object", additionalProperties: false, properties: {
    key: { anyOf: [{ type: "object", additionalProperties: false, properties: facts, required: Object.keys(facts) }, { type: "null" }], description: "Your saved key's facts, or null when you have none." },
    unreadable: { type: "boolean", description: "A saved key can no longer be opened, counts as none and is added again." },
  }, required: ["key", "unreadable"] },
  AssistantKeyRemoved: { type: "object", additionalProperties: false, properties: { removed: { type: "boolean", description: "False when there was none." } }, required: ["removed"] },
};
