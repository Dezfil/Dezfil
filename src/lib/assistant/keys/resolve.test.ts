import type { Database } from "better-sqlite3";
import { beforeEach, expect, it } from "vitest";
import { open } from "@/lib/metadata/db";
import { insertAccount } from "@/lib/metadata/accounts";
import { ownKeyAvailability } from "../config";
import { ADD_IT_AGAIN, ADD_YOUR_KEY, resolvePayer } from "./resolve";
import { saveAssistantKey } from "./store";

let db: Database;
beforeEach(() => {
  db = open(":memory:");
  for (const id of ["ada", "lin"]) insertAccount({ id, name: id, email: `${id}@example.test`, passwordHash: null, isAdmin: false, status: "active", now: "time" }, db);
});

it("answers the caller's own key first, whatever the instance has", () => {
  saveAssistantKey("ada", "openai", "sk-ada-own-key-00000000000", db, 1000);
  for (const env of [{}, { ANTHROPIC_API_KEY: "instance-key" }]) {
    expect(resolvePayer("ada", env, db)).toMatchObject({ kind: "own", provider: "openai", key: "sk-ada-own-key-00000000000", instanceKey: "ANTHROPIC_API_KEY" in env,
      facts: { provider: "openai", lastFour: "0000", savedAt: new Date(1000).toISOString() } });
  }
});

it("answers the instance's key for someone with none, and never another person's", () => {
  saveAssistantKey("ada", "openai", "sk-ada-own-key-00000000000", db);
  const payer = resolvePayer("lin", { ANTHROPIC_API_KEY: "instance-key" }, db);
  expect(payer).toEqual({ kind: "instance", provider: "anthropic", instanceKey: true, unreadable: false });
  expect(JSON.stringify(payer)).not.toContain("sk-ada");
});

it("answers nobody with the person's sentence where the server has no key, an operator's mistake included", () => {
  expect(resolvePayer("lin", {}, db)).toEqual({ kind: "none", reason: ADD_YOUR_KEY, instanceKey: false, unreadable: false });
  expect(resolvePayer("lin", { DEZFIL_AI_PROVIDER: "other" }, db)).toMatchObject({ kind: "none", reason: ADD_YOUR_KEY });
});

it("reads a key that no longer opens as none, saying to add it again", () => {
  saveAssistantKey("ada", "openai", "sk-ada-own-key-00000000000", db);
  db.prepare("UPDATE assistant_keys SET key_encrypted = 'AAAA:BBBB:CCCC'").run();
  expect(resolvePayer("ada", {}, db)).toEqual({ kind: "none", reason: ADD_IT_AGAIN, instanceKey: false, unreadable: true });
  expect(resolvePayer("ada", { OPENAI_API_KEY: "instance-key" }, db)).toEqual({ kind: "instance", provider: "openai", instanceKey: true, unreadable: true });
});

it("applies the offer lists to a person's provider and the default override only to the instance key's", () => {
  const env = { ANTHROPIC_API_KEY: "instance", DEZFIL_AI_MODEL: "claude-custom", DEZFIL_AI_MODELS_OPENAI: "gpt-6-astra,gpt-5.6-nova", DEZFIL_AI_MODELS_ANTHROPIC: "claude-opus-5" };
  expect(ownKeyAvailability("openai", env)).toEqual({ enabled: true, provider: "openai", model: "gpt-5.6-terra", models: ["gpt-5.6-terra", "gpt-6-astra", "gpt-5.6-nova"] });
  expect(ownKeyAvailability("anthropic", env)).toEqual({ enabled: true, provider: "anthropic", model: "claude-custom", models: ["claude-custom", "claude-opus-5"] });
  expect(ownKeyAvailability("openai", { DEZFIL_AI_MODEL: "ignored" })).toMatchObject({ model: "gpt-5.6-terra" });
});
