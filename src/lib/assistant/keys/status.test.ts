import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { authenticateSession, createApiToken, issueSession } from "@/lib/auth/credentials";
import { getAccount } from "@/lib/metadata/accounts";
import { resetSecretKeyCache } from "@/lib/secrets";
import { testAccountScope } from "@/lib/test-support/accounts";
import { dispatchAssistantTestRoute } from "../testing/route-dispatch";
import { saveAssistantKey } from "./store";

/** The status read answers for its caller, through the real route and store. */

const origin = "http://127.0.0.1:3219";
let dir: string;
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-key-status-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb(); resetSecretKeyCache();
  vi.stubGlobal("fetch", () => { throw new Error("the status read reached the network"); });
});
afterEach(async () => { closeMetadataDb(); resetSecretKeyCache(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

function person(id: string, admin = false) {
  const db = metadataDb();
  testAccountScope(db, id);
  if (admin) db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = ?").run(id);
  const context = authenticateSession(issueSession(getAccount(id, db)!, db, Date.now()).secret, db)!;
  const token = createApiToken(context, "Route fixture", db).secret;
  return (url = "/api/assistant") => dispatchAssistantTestRoute(new Request(`${origin}${url}`, { headers: { authorization: `Bearer ${token}` } }));
}
const read = async (call: ReturnType<typeof person>) => await (await call()).json() as Record<string, unknown> & { models?: { id: string }[] };
const SAVED = Date.parse("2026-10-31T10:00:00Z");

it("differs per person on an instance with a key: own Anthropic, own OpenAI, the instance's", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-instance-key-from-the-server");
  vi.stubEnv("DEZFIL_AI_MODEL", "claude-custom");
  vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", "gpt-6-astra,gpt-5.6-terra");
  const [ada, bea, cal] = [person("ada"), person("bea"), person("cal")];
  saveAssistantKey("ada", "anthropic", "sk-ada-own-anthropic-key-beef", metadataDb(), SAVED);
  saveAssistantKey("bea", "openai", "sk-bea-own-openai-key-0000f00d", metadataDb(), SAVED);

  const own = await read(ada);
  expect(own).toMatchObject({ enabled: true, provider: "anthropic", model: "claude-custom", instanceKey: true,
    payer: { kind: "own", provider: "anthropic", lastFour: "beef", savedAt: "2026-10-31T10:00:00.000Z" } });
  // The instance's default override applies to the instance key's provider, and
  // the offer list of the provider in use applies to a personal key.
  const other = await read(bea);
  expect(other).toMatchObject({ enabled: true, provider: "openai", model: "gpt-5.6-terra", instanceKey: true,
    payer: { kind: "own", provider: "openai", lastFour: "f00d" } });
  expect(other.models!.map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-5.6-terra"]);
  const instance = await read(cal);
  expect(instance).toMatchObject({ enabled: true, provider: "anthropic", model: "claude-custom", instanceKey: true, payer: { kind: "instance", provider: "anthropic" } });
  expect(JSON.stringify(instance)).not.toMatch(/beef|f00d|lastFour/);
});

it("answers disabled in the person's words on an instance with no key, never the operator's", async () => {
  const [ada, cal] = [person("ada"), person("cal")];
  saveAssistantKey("ada", "openai", "sk-ada-own-openai-key-00000000", metadataDb());
  expect(await read(ada)).toMatchObject({ enabled: true, instanceKey: false, payer: { kind: "own", provider: "openai" } });
  const none = await read(cal);
  expect(none).toEqual({ enabled: false, reason: "Add your own API key to use the assistant.", instanceKey: false });
  expect(JSON.stringify(none)).not.toMatch(/API_KEY|restart|DEZFIL/);
});

it("keeps an operator's forced provider out of what a person is told", async () => {
  vi.stubEnv("DEZFIL_AI_PROVIDER", "openai");
  expect((await read(person("cal"))).reason).toBe("Add your own API key to use the assistant.");
});

it("says to add a key again when it can no longer be read, on either kind of instance", async () => {
  const ada = person("ada");
  saveAssistantKey("ada", "openai", "sk-ada-own-openai-key-00000000", metadataDb());
  metadataDb().prepare("UPDATE assistant_keys SET key_encrypted = 'AAAA:BBBB:CCCC'").run();
  expect(await read(ada)).toEqual({ enabled: false, reason: "Your saved API key can no longer be read. Add it again.", instanceKey: false });
  vi.stubEnv("OPENAI_API_KEY", "sk-instance-key-from-the-server");
  expect(await read(ada)).toMatchObject({ enabled: true, payer: { kind: "instance", provider: "openai" }, unreadableKey: true });
});

it("carries no key fact in the Users list or the directory search", async () => {
  const admin = person("root", true), member = person("ada");
  saveAssistantKey("ada", "anthropic", "sk-ada-own-anthropic-key-beef", metadataDb(), SAVED);
  const reads = [await admin("/api/users"), await admin("/api/accounts/search?q=ada"), await member("/api/accounts/search?q=ada")];
  // Only a deactivated account has a deletion preview, and deactivation keeps the key.
  metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'ada'").run();
  reads.push(await admin("/api/users/ada/deletion-preview"));
  for (const response of reads) {
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/beef|lastFour|sk-ada|assistant_?key|anthropic/i);
    expect(text).not.toContain(new Date(SAVED).toISOString());
  }
});
