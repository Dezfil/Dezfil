import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, expect, it } from "vitest";
import { AssistantRunStore, type RunReceipt } from "./runs";
import { compactReceipt, jsonBytes } from "./recovery-data";

/**
 * Provenance inside existing bounds: the two model-choice facts are facts
 * the record keeps, not display detail it may trim, and adding them moves
 * none of the limits.
 *
 * The bounds are exercised through the production compaction and the
 * store's own reads at their exact boundaries, with a multibyte identity,
 * and at each of the three terminals. Admission's terminal reservation is
 * measured rather than assumed: the headroom it leaves shrinks by exactly
 * the bytes provenance adds, which is zero if it were not counted.
 */

const CHOICE = { model: "gpt-6-astra", effort: "xhigh", defaulted: { model: false, effort: true } };
const REPORTED = "gpt-6-astra-2026-09-01";
/** An identity outside the Latin-1 range, with a surrogate pair in it. */
const MULTIBYTE = "gpt-6-астра-模型-🛰";
/** The bytes of a value, counted here rather than by the production
 * counter the compaction uses: a ruler the thing measured supplies cannot
 * catch a mis-measurement in it. */
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const TERMINAL = 65_536;
const LIVE = 1_048_576;

/** A bound run carrying both facts, and whatever else the caller records. */
function run(record: (store: AssistantRunStore, id: string) => void = () => {}) {
  const store = new AssistantRunStore();
  const id = store.reserve(testAccountScope()).id;
  store.bind(testAccountScope(), id, {});
  store.bindChoice(testAccountScope(), id, CHOICE);
  record(store, id);
  return { store, id };
}

describe("the model-choice facts inside bounds", () => {
  it("survives the terminal compaction that drops the text and the arguments", () => {
    const { store, id } = run((s, runId) => {
      s.record(testAccountScope(), runId, { type: "message", text: "é".repeat(50_000) });
      s.record(testAccountScope(), runId, { type: "tool_call", id: "call-1", tool: "create_map", args: { name: "x".repeat(80_000) } });
      s.record(testAccountScope(), runId, { type: "tool_result", id: "call-1", tool: "create_map", ok: true, body: { rows: ["RAW_BODY_MUST_NOT_SURVIVE"] } });
      s.reported(testAccountScope(), runId, REPORTED);
    });
    store.finish(testAccountScope(), id);
    const receipt = store.read(testAccountScope(), id);
    expect(bytes(receipt)).toBeLessThanOrEqual(TERMINAL);
    expect(receipt.incomplete).toBe(true);
    // The display detail went; the two facts are whole.
    expect(receipt.actions).toEqual([{ id: "call-1", tool: "create_map", status: "succeeded", omitted: true }]);
    expect(receipt.provenance).toEqual({ requested: CHOICE, reported: [REPORTED] });
  });

  it("holds at the exact boundary of each bound, and past it trims the text and not the facts", () => {
    const { store, id } = run((s, runId) => { s.reported(testAccountScope(), runId, REPORTED); s.reported(testAccountScope(), runId, undefined); });
    store.finish(testAccountScope(), id);
    const base = { ...store.read(testAccountScope(), id), text: "", incomplete: false };
    for (const [bound, terminal] of [[TERMINAL, true], [LIVE, false]] as const) {
      const exact = { ...base, text: "x".repeat(bound - jsonBytes(base)) };
      expect(bytes(exact)).toBe(bound);
      // At the bound: nothing moves, provenance included.
      expect(compactReceipt(exact, bound, terminal)).toEqual(exact);
      // One byte past it: the text is what gives way, the facts are not.
      // (The mark itself buys a byte back: `true` is shorter than `false`,
      // so the prefix that fits is not always shorter than the text was.)
      const over = compactReceipt({ ...exact, text: exact.text + "x" }, bound, terminal);
      expect(over.incomplete).toBe(true);
      expect(bytes(over)).toBeLessThanOrEqual(bound);
      expect(over.text.length).toBeLessThan(exact.text.length + 2);
      expect(over.provenance).toEqual({ requested: CHOICE, reported: [REPORTED, null] });
    }
  });

  it("a bound too small for the facts themselves refuses rather than dropping them", () => {
    const { store, id } = run((s, runId) => s.reported(testAccountScope(), runId, REPORTED));
    store.finish(testAccountScope(), id);
    const receipt = store.read(testAccountScope(), id);
    // Everything trimmable is already gone at this bound, so what does not
    // fit is the record itself: the documented refusal, not a quiet loss.
    expect(() => compactReceipt(receipt, 64, true)).toThrow("live recovery bound");
    expect(store.read(testAccountScope(), id).provenance).toEqual({ requested: CHOICE, reported: [REPORTED] });
  });

  it("a multibyte identity survives byte for byte, and the trimmed text stays whole", () => {
    const store = new AssistantRunStore();
    const id = store.reserve(testAccountScope()).id;
    store.bind(testAccountScope(), id, {});
    store.bindChoice(testAccountScope(), id, { model: MULTIBYTE, effort: "max", defaulted: { model: false, effort: false } });
    store.record(testAccountScope(), id, { type: "message", text: "🛰".repeat(40_000) });
    store.reported(testAccountScope(), id, `${MULTIBYTE}-2026`);
    store.finish(testAccountScope(), id);
    const receipt = store.read(testAccountScope(), id);
    expect(bytes(receipt)).toBeLessThanOrEqual(TERMINAL);
    expect(receipt.provenance).toEqual({
      requested: { model: MULTIBYTE, effort: "max", defaulted: { model: false, effort: false } },
      reported: [`${MULTIBYTE}-2026`],
    });
    // The prefix that survived is still text: no surrogate pair was split.
    expect(Buffer.from(receipt.text, "utf8").toString("utf8")).toBe(receipt.text);
    expect(receipt.text.endsWith("🛰")).toBe(true);
    // And the boundary holds with multibyte text: at the bound, untouched.
    const base = { ...receipt, text: "", incomplete: false };
    const room = TERMINAL - jsonBytes(base);
    const exact = { ...base, text: "🛰".repeat(Math.floor(room / 4)) };
    expect(compactReceipt(exact, TERMINAL, true)).toEqual(exact);
  });

  it("completed, failed and interrupted terminals each keep the facts", () => {
    const completed = run((s, runId) => s.reported(testAccountScope(), runId, REPORTED));
    completed.store.finish(testAccountScope(), completed.id);
    const failed = run((s, runId) => s.reported(testAccountScope(), runId, REPORTED));
    failed.store.fail(testAccountScope(), failed.id, { code: "assistant_provider", message: "The provider failed." });
    const interrupted = run((s, runId) => s.reported(testAccountScope(), runId, REPORTED));
    interrupted.store.record(testAccountScope(), interrupted.id, { type: "done", reason: "interrupted" });
    interrupted.store.finish(testAccountScope(), interrupted.id);
    // The fourth terminal: a parked run released without an answer at all.
    const released = run((s, runId) => s.record(testAccountScope(), runId, { type: "confirm_required", id: "open", tool: "delete_map", args: { id: "m" } }));
    released.store.release(testAccountScope(), released.id);
    const facts = (entry: { store: AssistantRunStore; id: string }) => {
      const receipt: RunReceipt = entry.store.read(testAccountScope(), entry.id);
      return { state: receipt.state, provenance: receipt.provenance };
    };
    expect({
      completed: facts(completed), failed: facts(failed),
      interrupted: facts(interrupted), released: facts(released),
    }).toEqual({
      completed: { state: "completed", provenance: { requested: CHOICE, reported: [REPORTED] } },
      failed: { state: "failed", provenance: { requested: CHOICE, reported: [REPORTED] } },
      interrupted: { state: "interrupted", provenance: { requested: CHOICE, reported: [REPORTED] } },
      // No provider response ever completed here, and the record says so.
      released: { state: "interrupted", provenance: { requested: CHOICE } },
    });
  });

  it("admission reserves terminal space for the facts: the headroom shrinks by exactly their bytes", () => {
    // The largest action identity admission accepts, with and without the
    // facts recorded. Admission's own refusal is the oracle; nothing here
    // reimplements its arithmetic.
    const largest = (facts: boolean) => {
      let lo = 0; let hi = TERMINAL;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const store = new AssistantRunStore();
        const id = store.reserve(testAccountScope()).id;
        store.bind(testAccountScope(), id, {});
        if (facts) { store.bindChoice(testAccountScope(), id, CHOICE); store.reported(testAccountScope(), id, REPORTED); }
        try { store.admit(testAccountScope(), id, { id: "a".repeat(mid), name: "create_map", args: {} }); lo = mid; }
        catch { hi = mid - 1; }
      }
      return lo;
    };
    const bare = new AssistantRunStore(); const bareId = bare.reserve(testAccountScope()).id; bare.bind(testAccountScope(), bareId, {});
    const carrying = new AssistantRunStore(); const carryingId = carrying.reserve(testAccountScope()).id; carrying.bind(testAccountScope(), carryingId, {});
    carrying.bindChoice(testAccountScope(), carryingId, CHOICE); carrying.reported(testAccountScope(), carryingId, REPORTED);
    const added = jsonBytes(carrying.read(testAccountScope(), carryingId)) - jsonBytes(bare.read(testAccountScope(), bareId));
    expect(added).toBeGreaterThan(0);
    // Not counted, this difference would be zero.
    expect(largest(false) - largest(true)).toBe(added);
  });

  it("the limits, eviction, expiry and exact pending arguments are where they were", () => {
    // Eviction: 256 terminal receipts retained, each carrying the facts.
    const store = new AssistantRunStore();
    const ids: string[] = [];
    for (let i = 0; i < 256; i += 1) {
      const id = store.reserve(testAccountScope()).id; ids.push(id);
      store.bind(testAccountScope(), id, { message: "Once" }); store.bindChoice(testAccountScope(), id, CHOICE); store.reported(testAccountScope(), id, REPORTED);
      store.finish(testAccountScope(), id);
    }
    expect(store.read(testAccountScope(), ids[0]).provenance).toEqual({ requested: CHOICE, reported: [REPORTED] });
    const next = store.reserve(testAccountScope()).id; store.bind(testAccountScope(), next, {}); store.bindChoice(testAccountScope(), next, CHOICE); store.finish(testAccountScope(), next);
    expect(() => store.read(testAccountScope(), ids[0])).toThrow("unavailable");
    expect(store.read(testAccountScope(), ids[1]).provenance).toEqual({ requested: CHOICE, reported: [REPORTED] });

    // Expiry and the live bound: a reservation still expires at five
    // minutes, a bound run carrying the facts does not, and its open
    // confirmation keeps its exact arguments.
    let clock = 0;
    const timed = new AssistantRunStore(() => clock);
    const reserved = timed.reserve(testAccountScope()).id;
    const running = timed.reserve(testAccountScope()).id;
    timed.bind(testAccountScope(), running, { message: "Work" }); timed.bindChoice(testAccountScope(), running, CHOICE); timed.reported(testAccountScope(), running, REPORTED);
    const args = { id: "target", detail: "a".repeat(100_000) };
    timed.record(testAccountScope(), running, { type: "confirm_required", id: "open", tool: "delete_map", args });
    timed.record(testAccountScope(), running, { type: "message", text: "é".repeat(600_000) });
    clock = 299_999; expect(timed.read(testAccountScope(), reserved).state).toBe("reserved");
    clock += 1; expect(timed.read(testAccountScope(), reserved).state).toBe("unavailable");
    clock = 86_400_000;
    const live = timed.read(testAccountScope(), running);
    expect(live.state).toBe("awaiting_confirmation");
    expect(bytes(live)).toBeLessThanOrEqual(LIVE);
    expect(live.pending?.args).toEqual(args);
    expect(timed.pending(testAccountScope())[0].args).toEqual(args);
    expect(live.provenance).toEqual({ requested: CHOICE, reported: [REPORTED] });
  });

  it("reading the record changes nothing about it", () => {
    const { store, id } = run((s, runId) => s.reported(testAccountScope(), runId, REPORTED));
    store.finish(testAccountScope(), id);
    const first = store.read(testAccountScope(), id);
    const second = store.read(testAccountScope(), id);
    expect(second).toEqual(first);
    // A read hands out a copy: writing to it reaches no stored state.
    first.provenance!.reported!.push("gpt-5.6-terra");
    expect(store.read(testAccountScope(), id).provenance).toEqual({ requested: CHOICE, reported: [REPORTED] });
  });
});
