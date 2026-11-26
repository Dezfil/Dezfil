import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { testClient } from "@/lib/mcp/test-client";
import { defaultStyle } from "@/lib/style/defaults";
import type { LabelStyle } from "@/lib/style/style";
import { journeyClient } from "../../../scripts/mcp-journey-core.mjs";
import { corePrompt } from "./core-prompt";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";

/**
 * The words the embedded assistant reads about a label's paint, against
 * what the generated tools do with a label. The tools are walked first,
 * sentence by sentence of the guidance, and the texts are read after, so
 * each phrase checked below is one the tools were seen to honour: the two
 * choices, a part made the label's own with and without its choice, a part
 * taken back to Automatic leaving the other alone, a choice deciding over
 * the values beside it, and a label read back and written back keeping
 * its choices.
 */

const FIXTURE = "src/lib/plugins/fixtures/assistant-system.txt";

let dir: string;
let client: Awaited<ReturnType<typeof testClient>>;
let journey: Awaited<ReturnType<typeof journeyClient>>;
beforeAll(async () => {
  dir = await mkdtemp(`${process.cwd()}/.tmp-label-words-`);
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb();
  resetQueryInstance();
  client = await testClient(dispatchAssistantTestRoute);
  journey = await journeyClient(client, async (url: string) =>
    (await dispatchAssistantTestRoute(new Request(`http://localhost:3307${url}`))).json());
});
afterAll(async () => {
  await client?.close();
  closeMetadataDb();
  resetQueryInstance();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const RED = { r: 200, g: 40, b: 40, a: 1 };
const NAVY = { r: 16, g: 32, b: 48, a: 1 };

/** The phrases the guidance states, each walked through the tools below. */
const STATED = [
  "`textpaint` and `halopaint` \"automatic\"",
  "send `textpaint` \"own\" with a `color`",
  "`halopaint` \"own\" with `halowidth` and `halocolor`",
  "with no choice sent, those values alone mean the same",
  "set a choice to \"automatic\" to take that part back; the other part stays as it is",
  "a choice sent decides over the values beside it",
  "a label read back carries both choices, so writing it back keeps them",
];

/** What the guidance said before a label could follow the map, each
 * contradicted by the walk: a new label's halo is not off, and the halo
 * over imagery is not the agent's to pick by hand. */
const REFUTED = [
  { claim: "a new label has no halo", pattern: /halo\s+off by default/i },
  { claim: "a dark halo over imagery is set by hand", pattern: /set haloWidth 1 with a dark haloColor/i },
];

/** Problems with a text, read with its line breaks and indents as spaces. */
function readAgainstTheTools(text: string): string[] {
  const flat = text.replace(/\s+/g, " ").toLowerCase();
  return [
    ...STATED.filter((phrase) => !flat.includes(phrase)).map((phrase) => `does not state: ${phrase}`),
    ...REFUTED.filter(({ pattern }) => pattern.test(text.replace(/\s+/g, " "))).map(({ claim }) => `claims what the tools refute: ${claim}`),
  ];
}

describe("the label paint the guidance describes", () => {
  it("is what the generated tools do with a label", async () => {
    const map = await journey.call("create_map", { name: "Words" });
    const revision = async () => (await journey.call("get_map", { id: map.id })).editRevision as string;
    const style = (label: Record<string, unknown>) => ({ ...defaultStyle("POINT"), label });
    const create = async (label: Record<string, unknown>) =>
      (await journey.call("create_layer", { id: map.id, name: "Places", sql: "SELECT 'Harbour' AS name, ST_Point(13.4, 52.5) AS geometry",
        style: style(label), expected_revision: await revision() })) as { id: string; style: { label: LabelStyle } };
    const update = async (id: string, label: Record<string, unknown>) =>
      ((await journey.call("update_layer", { id, style: style(label), expected_revision: await revision() })) as { style: { label: LabelStyle } }).style.label;
    const choices = (label: LabelStyle) => [label.textPaint, label.haloPaint];

    // By default both parts follow the map.
    const layer = await create({ attribute: "name", size: 12 });
    let label = layer.style.label;
    expect(choices(label)).toEqual(["automatic", "automatic"]);
    // Read back and written back with another change, they keep following it.
    label = await update(layer.id, { ...label, size: 16 });
    expect(choices(label)).toEqual(["automatic", "automatic"]);
    // "own" with its values: the text, then the halo.
    label = await update(layer.id, { ...label, textPaint: "own", color: RED });
    expect([...choices(label), label.color]).toEqual(["own", "automatic", RED]);
    label = await update(layer.id, { ...label, haloPaint: "own", haloWidth: 2, haloColor: NAVY });
    expect([...choices(label), label.haloWidth, label.haloColor]).toEqual(["own", "own", 2, NAVY]);
    // Automatic takes one part back and leaves the other as it was.
    label = await update(layer.id, { ...label, textPaint: "automatic" });
    expect([...choices(label), label.haloWidth, label.haloColor]).toEqual(["automatic", "own", 2, NAVY]);
    // A choice sent decides over the values beside it.
    label = await update(layer.id, { ...label, haloPaint: "automatic", haloWidth: 3, haloColor: RED });
    expect(choices(label)).toEqual(["automatic", "automatic"]);
    expect(label.haloWidth).not.toBe(3);
    // With no choice sent, the values alone make the part the label's own.
    const valuesOnly = await create({ attribute: "name", size: 12, color: RED, haloWidth: 2, haloColor: NAVY });
    expect(choices(valuesOnly.style.label)).toEqual(["own", "own"]);
  });

  it("is stated in the embedded prompt and in its captured fixture", () => {
    expect({
      "core-prompt.ts": readAgainstTheTools(corePrompt()),
      [FIXTURE]: readAgainstTheTools(readFileSync(FIXTURE, "utf8")),
    }).toEqual({ "core-prompt.ts": [], [FIXTURE]: [] });
  });

  it("control: the reading reports a missing statement and an old claim, on the words that carried them", () => {
    const wasInThePrompt =
      "Labels: merge `label` into the style: `{attribute, size, color, haloWidth, haloColor}` on simple layers. Halo\n" +
      "  off by default (haloWidth 0); set haloWidth 1 with a dark haloColor over satellite imagery or busy basemaps.";
    expect(readAgainstTheTools(wasInThePrompt)).toEqual([
      ...STATED.map((phrase) => `does not state: ${phrase}`),
      "claims what the tools refute: a new label has no halo",
      "claims what the tools refute: a dark halo over imagery is set by hand",
    ]);
  });
});
