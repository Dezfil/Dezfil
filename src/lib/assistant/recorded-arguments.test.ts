import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "@/app/api/instance/settings/route";
import { resetSecretKeyCache } from "@/lib/secrets";
import { resolveServiceAddress } from "@/lib/settings/service-address";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { testAccountScope } from "@/lib/test-support/accounts";
import { buildTools, type ToolDef } from "@/lib/tools/tools";
import { socketRequest } from "./testing/socket-request";
import { words } from "./action-execution";
import { prepareConfirmation } from "./confirmation";
import { runAssistant, resumeAssistant, type AssistantEvent } from "./loop";
import { PendingActionStore } from "./pending";
import { stubProvider } from "./providers/stub";
import { recordedArguments } from "./recorded-arguments";
import { runStream } from "./run-stream";
import { assistantRuns } from "./runs";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";

/**
 * An address given to the embedded assistant goes out as given, and appears
 * as scheme and host in everything the server forms about the call: the
 * confirmation it asks for, the run's events, its pending receipt and its
 * stored record, settled confirmation included.
 */

// Nothing here leaves the process; a request that tried fails its test.
keepRequestsOnThisMachine();

const SEEDS = ["SEEDED-KEY-0001-USER", "SEEDED-KEY-0001-PATH", "SEEDED-KEY-0001-QUERY"];
// A public literal: the save-time check admits it without a lookup.
const ADDRESS = `https://seed-user:${SEEDS[0]}@203.0.113.10/${SEEDS[1]}/search?key=${SEEDS[2]}`;
const ORIGIN = "https://203.0.113.10";
// The satellite imagery's tile template, its key in the path and the query;
// with the user information too, a save refuses it.
const TEMPLATE = `https://203.0.113.10/${SEEDS[1]}/{z}/{x}/{y}.jpg?key=${SEEDS[2]}`;
const TEMPLATE_WITH_USER = `https://seed-user:${SEEDS[0]}@203.0.113.10/${SEEDS[1]}/{z}/{x}/{y}.jpg?key=${SEEDS[2]}`;

let f: ReturnType<typeof instanceSettingsFixture>;
let sent: unknown[];

beforeEach(() => {
  f = instanceSettingsFixture();
  vi.stubEnv("DEZFIL_SECRET_KEY", "7c".repeat(32)); resetSecretKeyCache();
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
  assistantRuns.resetForTests();
  sent = [];
});
afterEach(() => { assistantRuns.resetForTests(); f.close(); resetSecretKeyCache(); });

/** The instance's own route, as the assistant's tools reach it. */
async function dispatch(input: RequestInfo | URL, init?: RequestInit) {
  const incoming = input instanceof Request ? input : new Request(String(input), init);
  sent.push(await incoming.clone().json().catch(() => null));
  const headers = new Headers(incoming.headers);
  headers.set("authorization", `Bearer ${f.token.secret}`);
  return PATCH(socketRequest(new Request(incoming, { headers })));
}

async function streamed(response: Response): Promise<AssistantEvent[]> {
  return (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as AssistantEvent);
}

function expectNoSeed(value: unknown) {
  const text = JSON.stringify(value);
  for (const seed of SEEDS) expect(text).not.toContain(seed);
}

describe("an address saved through the embedded assistant", () => {
  it.each([
    ["geocoderUrl", ADDRESS], ["satelliteUrl", TEMPLATE],
  ] as const)("%s is recorded as scheme and host in the confirmation, the events, the pending receipt and the stored record", async (key, given) => {
    const scope = testAccountScope(f.db, "admin");
    const pending = new PendingActionStore();
    const provider = stubProvider([
      { text: "", toolCalls: [{ id: "point-the-finder", name: "update_instance_settings", args: { [key]: given } }] },
      { text: "Done.", toolCalls: [] },
    ]);
    const run = assistantRuns.reserve(scope);
    assistantRuns.bind(scope, run.id, { message: "Use our address finder" });
    const deps = { scope, baseUrl: "http://instance.test", pending, fetchImpl: dispatch as typeof fetch, runId: run.id };

    const asked = await streamed(runStream(scope, runAssistant(provider, { message: "Use our address finder", history: [] }, deps), run.id));
    const question = asked.find(event => event.type === "confirm_required");
    if (question?.type !== "confirm_required") throw new Error("expected a confirmation");
    expect(question.args).toEqual({ [key]: ORIGIN });
    expect(question.confirmation).toMatchObject({ target: "Change instance settings?" });
    expect(assistantRuns.pending(scope)).toEqual([expect.objectContaining({ args: { [key]: ORIGIN } })]);
    expect(sent).toEqual([]);
    expectNoSeed([asked, assistantRuns.pending(scope), assistantRuns.read(scope, run.id)]);

    const parked = pending.claim(scope, question.id, "approved")!;
    assistantRuns.resume(scope, run.id, "approved");
    const done = await streamed(runStream(scope, resumeAssistant(parked, true, deps), run.id));
    expect(done).toContainEqual(expect.objectContaining({ type: "tool_call", tool: "update_instance_settings", args: { [key]: ORIGIN } }));
    expect(done).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "update_instance_settings", ok: true }));

    const record = assistantRuns.read(scope, run.id);
    expect(record.actions).toEqual([expect.objectContaining({ tool: "update_instance_settings", args: { [key]: ORIGIN }, status: "succeeded" })]);
    expect(record.confirmations).toEqual([expect.objectContaining({ decision: "approved", args: { [key]: ORIGIN } })]);
    expectNoSeed([done, record]);

    // The call itself went out with the address as given, and was kept.
    expect(sent).toEqual([{ [key]: given }]);
    expect(resolveServiceAddress(key, f.db)).toEqual({ address: given, source: "stored" });
  });
});

describe("a tile template carrying user information, given to the embedded assistant", () => {
  it("is refused after its confirmation, saying where the key belongs, and nothing about the call repeats it", async () => {
    const scope = testAccountScope(f.db, "admin");
    const pending = new PendingActionStore();
    const provider = stubProvider([
      { text: "", toolCalls: [{ id: "point-the-imagery", name: "update_instance_settings", args: { satelliteUrl: TEMPLATE_WITH_USER } }] },
      { text: "Refused.", toolCalls: [] },
    ]);
    const run = assistantRuns.reserve(scope);
    assistantRuns.bind(scope, run.id, { message: "Use our imagery" });
    const deps = { scope, baseUrl: "http://instance.test", pending, fetchImpl: dispatch as typeof fetch, runId: run.id };

    const asked = await streamed(runStream(scope, runAssistant(provider, { message: "Use our imagery", history: [] }, deps), run.id));
    const question = asked.find(event => event.type === "confirm_required");
    if (question?.type !== "confirm_required") throw new Error("expected a confirmation");
    expect(question.args).toEqual({ satelliteUrl: ORIGIN });
    const parked = pending.claim(scope, question.id, "approved")!;
    assistantRuns.resume(scope, run.id, "approved");
    const done = await streamed(runStream(scope, resumeAssistant(parked, true, deps), run.id));
    expect(done).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "update_instance_settings", ok: false }));
    expect(JSON.stringify(done)).toContain("A browser cannot load tiles from an address that carries a user name or password; put the key in the path or the query.");
    const record = assistantRuns.read(scope, run.id);
    expect(record.actions).toEqual([expect.objectContaining({ tool: "update_instance_settings", args: { satelliteUrl: ORIGIN } })]);
    expectNoSeed([asked, done, record, assistantRuns.pending(scope)]);
    // Sent as given, refused by the save; nothing was kept.
    expect(sent).toEqual([{ satelliteUrl: TEMPLATE_WITH_USER }]);
    expect(resolveServiceAddress("satelliteUrl", f.db).source).toBe("default");
  });
});

describe("an address argument that is not text", () => {
  it("is recorded as not an address, whatever it holds; a null, an empty text and every other argument stay as given", () => {
    expect(recordedArguments({ geocoderUrl: [ADDRESS], isochroneUrl: { address: ADDRESS }, overpassUrl: 7, s3Endpoint: true, satelliteUrl: { tiles: TEMPLATE }, previewRows: [ADDRESS] }))
      .toEqual({ geocoderUrl: "not an address", isochroneUrl: "not an address", overpassUrl: "not an address", s3Endpoint: "not an address", satelliteUrl: "not an address", previewRows: [ADDRESS] });
    const kept = { geocoderUrl: null, isochroneUrl: "", previewRows: 200 };
    expect(recordedArguments(kept)).toBe(kept);
  });

  it.each([
    ["a list", [ADDRESS]],
    ["an object", { address: ADDRESS }],
  ])("given as %s, reads as not an address in the confirmation, the events, the receipt and the record, and is refused", async (_what, given) => {
    const scope = testAccountScope(f.db, "admin");
    const pending = new PendingActionStore();
    const provider = stubProvider([
      { text: "", toolCalls: [{ id: "point-the-finder", name: "update_instance_settings", args: { geocoderUrl: given } }] },
      { text: "Refused.", toolCalls: [] },
    ]);
    const run = assistantRuns.reserve(scope);
    assistantRuns.bind(scope, run.id, { message: "Use our address finder" });
    const deps = { scope, baseUrl: "http://instance.test", pending, fetchImpl: dispatch as typeof fetch, runId: run.id };

    const asked = await streamed(runStream(scope, runAssistant(provider, { message: "Use our address finder", history: [] }, deps), run.id));
    const question = asked.find(event => event.type === "confirm_required");
    if (question?.type !== "confirm_required") throw new Error("expected a confirmation");
    expect(question.args).toEqual({ geocoderUrl: "not an address" });
    expect(assistantRuns.pending(scope)).toEqual([expect.objectContaining({ args: { geocoderUrl: "not an address" } })]);
    expectNoSeed([asked, assistantRuns.pending(scope), assistantRuns.read(scope, run.id)]);

    const parked = pending.claim(scope, question.id, "approved")!;
    assistantRuns.resume(scope, run.id, "approved");
    const done = await streamed(runStream(scope, resumeAssistant(parked, true, deps), run.id));
    expect(done).toContainEqual(expect.objectContaining({ type: "tool_call", tool: "update_instance_settings", args: { geocoderUrl: "not an address" } }));
    expect(done).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "update_instance_settings", ok: false }));
    const record = assistantRuns.read(scope, run.id);
    expect(record.actions).toEqual([expect.objectContaining({ tool: "update_instance_settings", args: { geocoderUrl: "not an address" } })]);
    expect(record.confirmations).toEqual([expect.objectContaining({ decision: "approved", args: { geocoderUrl: "not an address" } })]);
    expectNoSeed([done, record]);
    // Refused before it was sent; nothing was kept.
    expect(sent).toEqual([]);
    expect(resolveServiceAddress("geocoderUrl", f.db).source).toBe("default");
  });
});

describe("words declared over an address argument", () => {
  const settings = () => buildTools().find(tool => tool.name === "update_instance_settings")!;

  it("give the address as scheme and host in the confirmation's words", async () => {
    const tool: ToolDef = { ...settings(), confirmation: { target: "Send OpenStreetMap queries to {target}?", consequence: "Every import asks it.",
      subject: { path: null, argument: "overpassUrl", name: "" } } };
    const prepared = await prepareConfirmation(tool, { id: "call", name: tool.name, args: { overpassUrl: ADDRESS } }, { baseUrl: "http://instance.test" });
    expect(prepared?.words.target).toBe(`Send OpenStreetMap queries to ${ORIGIN}?`);
    for (const given of [[ADDRESS], { address: ADDRESS }]) {
      const malformed = await prepareConfirmation(tool, { id: "call", name: tool.name, args: { overpassUrl: given } }, { baseUrl: "http://instance.test" });
      expect(malformed?.words.target).toBe("Send OpenStreetMap queries to not an address?");
    }
  });

  it("give the address as scheme and host in the record's line, and text that is not one as such", () => {
    const tool: ToolDef = { ...settings(), display: { verb: "Pointed OpenStreetMap at {arg.overpassUrl}" } };
    expect(words(tool, { overpassUrl: ADDRESS }).label).toBe(`Pointed OpenStreetMap at ${ORIGIN}`);
    expect(words(tool, { overpassUrl: `not a link ${SEEDS[2]}` }).label).toBe("Pointed OpenStreetMap at not an address");
    expect(words(tool, { overpassUrl: [ADDRESS] }).label).toBe("Pointed OpenStreetMap at not an address");
    expect(words(tool, { overpassUrl: { address: ADDRESS } }).label).toBe("Pointed OpenStreetMap at not an address");
    expect(words(tool, { previewRows: 200 }).label).toBe("Pointed OpenStreetMap at");
  });
});
