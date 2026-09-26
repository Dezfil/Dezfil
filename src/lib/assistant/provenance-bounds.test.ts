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
  const id = store.reserve().id;
  store.bind(id, {});
  store.bindChoice(id, CHOICE);
  record(store, id);
  return { store, id };
}

describe("the model-choice facts inside bounds", () => {
  it("survives the terminal compaction that drops the text and the arguments", () => {
    const { store, id } = run((s, runId) => {
      s.record(runId, { type: "message", text: "é".repeat(50_000) });
      s.record(runId, { type: "tool_call", id: "call-1", tool: "create_map", args: { name: "x".repeat(80_000) } });
      s.record(runId, { type: "tool_result", id: "call-1", tool: "create_map", ok: true, body: { rows: ["RAW_BODY_MUST_NOT_SURVIVE"] } });
      s.reported(runId, REPORTED);
    });
    store.finish(id);
    const receipt = store.read(id);
    expect(bytes(receipt)).toBeLessThanOrEqual(TERMINAL);
    expect(receipt.incomplete).toBe(true);
    // The display detail went; the two facts are whole.
    expect(receipt.actions).toEqual([{ id: "call-1", tool: "create_map", status: "succeeded", omitted: true }]);
    expect(receipt.provenance).toEqual({ requested: CHOICE, reported: [REPORTED] });
  });

  it("holds at the exact boundary of each bound, and past it trims the text and not the facts", () => {
    const { store, id } = run((s, runId) => { s.reported(runId, REPORTED); s.reported(runId, undefined); });
    store.finish(id);
    const base = { ...store.read(id), text: "", incomplete: false };
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
    const { store, id } = run((s, runId) => s.reported(runId, REPORTED));
    store.finish(id);
    const receipt = store.read(id);
    // Everything trimmable is already gone at this bound, so what does not
    // fit is the record itself: the documented refusal, not a quiet loss.
    expect(() => compactReceipt(receipt, 64, true)).toThrow("live recovery bound");
    expect(store.read(id).provenance).toEqual({ requested: CHOICE, reported: [REPORTED] });
  });

  it("a multibyte identity survives byte for byte, and the trimmed text stays whole", () => {
    const store = new AssistantRunStore();
    const id = store.reserve().id;
    store.bind(id, {});
    store.bindChoice(id, { model: MULTIBYTE, effort: "max", defaulted: { model: false, effort: false } });
    store.record(id, { type: "message", text: "🛰".repeat(40_000) });
    store.reported(id, `${MULTIBYTE}-2026`);
    store.finish(id);
    const receipt = store.read(id);
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
    const completed = run((s, runId) => s.reported(runId, REPORTED));
    completed.store.finish(completed.id);
    const failed = run((s, runId) => s.reported(runId, REPORTED));
    failed.store.fail(failed.id, { code: "assistant_provider", message: "The provider failed." });
    const interrupted = run((s, runId) => s.reported(runId, REPORTED));
    interrupted.store.record(interrupted.id, { type: "done", reason: "interrupted" });
    interrupted.store.finish(interrupted.id);
    // The fourth terminal: a parked run released without an answer at all.
    const released = run((s, runId) => s.record(runId, { type: "confirm_required", id: "open", tool: "delete_map", args: { id: "m" } }));
    released.store.release(released.id);
    const facts = (entry: { store: AssistantRunStore; id: string }) => {
      const receipt: RunReceipt = entry.store.read(entry.id);
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
        const id = store.reserve().id;
        store.bind(id, {});
        if (facts) { store.bindChoice(id, CHOICE); store.reported(id, REPORTED); }
        try { store.admit(id, { id: "a".repeat(mid), name: "create_map", args: {} }); lo = mid; }
        catch { hi = mid - 1; }
      }
      return lo;
    };
    const bare = new AssistantRunStore(); const bareId = bare.reserve().id; bare.bind(bareId, {});
    const carrying = new AssistantRunStore(); const carryingId = carrying.reserve().id; carrying.bind(carryingId, {});
    carrying.bindChoice(carryingId, CHOICE); carrying.reported(carryingId, REPORTED);
    const added = jsonBytes(carrying.read(carryingId)) - jsonBytes(bare.read(bareId));
    expect(added).toBeGreaterThan(0);
    // Not counted, this difference would be zero.
    expect(largest(false) - largest(true)).toBe(added);
  });

  it("the limits, eviction, expiry and exact pending arguments are where they were", () => {
    // Eviction: 256 terminal receipts retained, each carrying the facts.
    const store = new AssistantRunStore();
    const ids: string[] = [];
    for (let i = 0; i < 256; i += 1) {
      const id = store.reserve().id; ids.push(id);
      store.bind(id, { message: "Once" }); store.bindChoice(id, CHOICE); store.reported(id, REPORTED);
      store.finish(id);
    }
    expect(store.read(ids[0]).provenance).toEqual({ requested: CHOICE, reported: [REPORTED] });
    const next = store.reserve().id; store.bind(next, {}); store.bindChoice(next, CHOICE); store.finish(next);
    expect(() => store.read(ids[0])).toThrow("unavailable");
    expect(store.read(ids[1]).provenance).toEqual({ requested: CHOICE, reported: [REPORTED] });

    // Expiry and the live bound: a reservation still expires at five
    // minutes, a bound run carrying the facts does not, and its open
    // confirmation keeps its exact arguments.
    let clock = 0;
    const timed = new AssistantRunStore(() => clock);
    const reserved = timed.reserve().id;
    const running = timed.reserve().id;
    timed.bind(running, { message: "Work" }); timed.bindChoice(running, CHOICE); timed.reported(running, REPORTED);
    const args = { id: "target", detail: "a".repeat(100_000) };
    timed.record(running, { type: "confirm_required", id: "open", tool: "delete_map", args });
    timed.record(running, { type: "message", text: "é".repeat(600_000) });
    clock = 299_999; expect(timed.read(reserved).state).toBe("reserved");
    clock += 1; expect(timed.read(reserved).state).toBe("unavailable");
    clock = 86_400_000;
    const live = timed.read(running);
    expect(live.state).toBe("awaiting_confirmation");
    expect(bytes(live)).toBeLessThanOrEqual(LIVE);
    expect(live.pending?.args).toEqual(args);
    expect(timed.pending()[0].args).toEqual(args);
    expect(live.provenance).toEqual({ requested: CHOICE, reported: [REPORTED] });
  });

  it("reading the record changes nothing about it", () => {
    const { store, id } = run((s, runId) => s.reported(runId, REPORTED));
    store.finish(id);
    const first = store.read(id);
    const second = store.read(id);
    expect(second).toEqual(first);
    // A read hands out a copy: writing to it reaches no stored state.
    first.provenance!.reported!.push("gpt-5.6-terra");
    expect(store.read(id).provenance).toEqual({ requested: CHOICE, reported: [REPORTED] });
  });
});
