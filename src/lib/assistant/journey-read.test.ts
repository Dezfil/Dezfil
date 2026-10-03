import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import * as metadata from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createMap, readMap } from "@/lib/map-service";
import { assistantJourneyFetch } from "../../../test-support/assistant-loopback";
import { runAssistant, resumeAssistant, type AssistantEvent } from "./loop";
import { stubProvider } from "./providers/stub";
import { PendingActionStore } from "./pending";

let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });

it("dispatches the journey's document reads through a turn, confirmation resume and whole-turn undo", async () => {
  const scope = testAccountScope(db), map = createMap(scope, "Before");
  const call = (name: string, args: Record<string, unknown>, id: string) => ({ name, args, id });
  const pending = new PendingActionStore();
  const deps = { scope, pending, baseUrl: "http://127.0.0.1:3000", fetchImpl: assistantJourneyFetch, autoCheck: false };
  const events: AssistantEvent[] = [];
  for await (const event of runAssistant(stubProvider([
    { text: "", toolCalls: [call("get_map", { id: map.id }, "read")] },
    { text: "", toolCalls: [call("update_map", { id: map.id, name: "After" }, "name"), call("update_map", { id: map.id, basemap: "dark" }, "base")] },
    { text: "", toolCalls: [call("publish_map", { id: map.id }, "publish")] },
    { text: "", toolCalls: [call("update_map", { id: map.id, name: "Live" }, "live")] },
    { text: "Done", toolCalls: [] },
  ]), { message: "Edit and publish", history: [] }, deps)) events.push(event);
  const confirmation = events.find(event => event.type === "confirm_required");
  expect(confirmation).toBeDefined();
  if (confirmation?.type !== "confirm_required") throw new Error("Expected confirmation");
  const parked = pending.claim(scope, confirmation.id, "approved")!;
  for await (const event of resumeAssistant(parked, true, deps)) events.push(event);
  expect(events.filter(event => event.type === "tool_result").every(event => event.ok)).toBe(true);
  expect(readMap(scope, map.id)).toMatchObject({ name: "Live", basemap: "dark" });
  for await (const event of runAssistant(stubProvider([
    { text: "", toolCalls: [call("get_map", { id: map.id }, "read-undo")] },
    { text: "", toolCalls: [call("undo_change", { id: map.id }, "undo")] },
    { text: "Done", toolCalls: [] },
  ]), { message: "Undo", history: [] }, deps)) {
    if (event.type === "tool_result") expect(event.ok).toBe(true);
  }
  expect(readMap(scope, map.id)).toMatchObject({ name: "Before", basemap: null });
});
