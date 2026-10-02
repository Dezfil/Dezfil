import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { CHANGE_GROUP_HEADER } from "@/lib/api/change-group";
import { buildTools } from "@/lib/tools/tools";
import { corePrompt } from "./core-prompt";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";

/**
 * The words an embedded or bare MCP agent reads about undo, against the
 * boundary the map's own history gives. The history is measured through the
 * documented routes first, and the texts are read against what it did, so
 * the check is a comparison with a product behavior rather than with a
 * second copy of the sentence.
 *
 * The boundary is the one built and record-route.test.ts demonstrates
 * from the assistant's side: consecutive edits carrying the same change
 * group undo together as one step, and an edit from outside the group
 * between them starts a new one, so a turn's edits can span steps.
 */

const origin = "http://127.0.0.1:3241";
let dir: string;

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-undo-words-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb();
  resetQueryInstance();
});
afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const call = (url: string, init: RequestInit = {}) =>
  dispatchAssistantTestRoute(new Request(origin + url, init));
/** An edit through the documented map route, grouped when a marker is given
 * exactly as any agent would group its own. */
async function edit(id: string, fields: Record<string, unknown>, group?: string, basis?: string) {
  const response = await call(`/api/maps/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(basis ? { "X-Edit-Revision": basis } : {}), ...(group ? { [CHANGE_GROUP_HEADER]: group } : {}) },
    body: JSON.stringify(fields),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}
const undo = async (id: string, basis: string) => {
  const response = await call(`/api/maps/${id}/undo`, { method: "POST", headers: { "X-Edit-Revision": basis } });
  expect(response.status, await response.clone().text()).toBe(200);
};
const readMap = async (id: string) =>
  (await (await call(`/api/maps/${id}`)).json()) as { name: string; legendCorner: string | null };

/**
 * The two phrases the boundary is stated in, taken from the plugin skill,
 * which names as the text that already states it correctly. Every
 * model-facing text has to carry the same two rather than a paraphrase of
 * this test's own making; the first case below checks the skill still holds
 * them, so the constants stay anchored to the repository's own sentence.
 */
const BOUNDARY = ["consecutive edits in a group form a step", "the latest step"];

/**
 * What the texts claimed, each refuted by the measurement in the first case:
 * one undo after a split left the group's earlier edit standing.
 */
const REFUTED = [
  { claim: "one undo reverts everything a turn changed", pattern: /in one turn[\s\S]{0,60}as a single step/i },
  { claim: "one undo reverts a whole change group", pattern: /whole group as one step/i },
];

function readAgainstTheBoundary(text: string): string[] {
  const problems: string[] = [];
  for (const phrase of BOUNDARY) {
    if (!text.toLowerCase().includes(phrase)) problems.push(`does not state that ${phrase}`);
  }
  for (const { claim, pattern } of REFUTED) {
    if (pattern.test(text)) problems.push(`claims what the history refuses: ${claim}`);
  }
  return problems;
}

const SKILL = "plugins/dezfil/skills/dezfil/SKILL.md";
const FIXTURE = "src/lib/plugins/fixtures/assistant-system.txt";
const undoTool = () => buildTools().find((tool) => tool.name === "undo_change")!;

describe("the boundary the map's history gives", () => {
  it("undoes consecutive grouped edits as one step, and stops at an edit from outside the group", async () => {
    // Grouped and consecutive: two different fields, so the timeline's
    // coalescing of same-shaped edits is not what is being measured.
    const grouped = createMap(testAccountScope(), "Original A");
    await edit(grouped.id, { name: "Renamed A" }, "turn-a", readEditRevision({ kind: "map", id: grouped.id })!.editRevision!);
    await edit(grouped.id, { legendCorner: "top-right" }, "turn-a", readEditRevision({ kind: "map", id: grouped.id })!.editRevision!);
    await undo(grouped.id, readEditRevision({ kind: "map", id: grouped.id })!.editRevision!);
    expect(await readMap(grouped.id)).toMatchObject({ name: "Original A", legendCorner: null });

    // The same group, with one ungrouped edit between its two edits.
    const split = createMap(testAccountScope(), "Original B");
    await edit(split.id, { name: "First" }, "turn-b", readEditRevision({ kind: "map", id: split.id })!.editRevision!);
    await edit(split.id, { name: "Manual" }, undefined, readEditRevision({ kind: "map", id: split.id })!.editRevision!);
    await edit(split.id, { legendCorner: "top-right" }, "turn-b", readEditRevision({ kind: "map", id: split.id })!.editRevision!);
    await undo(split.id, readEditRevision({ kind: "map", id: split.id })!.editRevision!);
    // One undo took the group's later edit alone: its earlier rename stands,
    // so a turn's edits are not one step and a whole group is not one step.
    expect(await readMap(split.id)).toMatchObject({ name: "Manual", legendCorner: null });
  });
});

describe("the words the model reads", () => {
  it("the skill still states the boundary this check measures against", () => {
    const skill = readFileSync(SKILL, "utf8").toLowerCase();
    for (const phrase of BOUNDARY) expect(skill, SKILL).toContain(phrase);
  });

  it("the embedded prompt, its captured fixture and the MCP tool description all state it", () => {
    // Read as one object, so a run that fails names every text at fault
    // rather than stopping at the first one.
    expect({
      "core-prompt.ts": readAgainstTheBoundary(corePrompt()),
      [FIXTURE]: readAgainstTheBoundary(readFileSync(FIXTURE, "utf8")),
      "undo_change, as generated for the model": readAgainstTheBoundary(undoTool().description),
    }).toEqual({ "core-prompt.ts": [], [FIXTURE]: [], "undo_change, as generated for the model": [] });
  });

  it("control: the reading reports both kinds of fault, on the exact words that carried them", () => {
    const wasInThePrompt =
      "call the undo tool on the map; everything you changed in one turn reverts as a single step, and redo brings it back.";
    const wasInTheDescription =
      "Reverts the most recent recorded change or, when it was part of a grouped turn, the whole group as one step.";
    expect(readAgainstTheBoundary(wasInThePrompt)).toEqual([
      "does not state that consecutive edits in a group form a step",
      "does not state that the latest step",
      "claims what the history refuses: one undo reverts everything a turn changed",
    ]);
    expect(readAgainstTheBoundary(wasInTheDescription)).toEqual([
      "does not state that consecutive edits in a group form a step",
      "does not state that the latest step",
      "claims what the history refuses: one undo reverts a whole change group",
    ]);
  });
});
