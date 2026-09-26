import { describe, expect, it, vi } from "vitest";
import type { DataTable } from "./api";
import {
  createUploadQueue,
  type SettleReport,
  type UploadRequestContext,
  type UploadTransportHandlers,
} from "./upload-queue";

/**
 * The upload batch queue engine: sequencing, settlement and dismissal
 * semantics proven against a hand-resolved transport — the plan's queue
 * coverage: ordering, one active request, appends, the fresh-batch
 * reset, every terminal outcome, one attempt per file, attributed
 * skips, and dismissal.
 */

function fakeTransport() {
  const calls: {
    name: string;
    handlers: UploadTransportHandlers;
    context: UploadRequestContext;
  }[] = [];
  return {
    calls,
    transport: (
      file: File,
      handlers: UploadTransportHandlers,
      context: UploadRequestContext,
    ) => {
      calls.push({ name: file.name, handlers, context });
    },
  };
}

function files(...names: string[]): File[] {
  return names.map((name) => new File(["content"], name));
}

const table = (name: string) => ({ name }) as DataTable;

describe("the upload queue engine", () => {
  it("runs one request at a time, in order, and appends mid-batch", () => {
    const { calls, transport } = fakeTransport();
    const queue = createUploadQueue(transport);
    queue.add(files("a.geojson", "b.geojson"));
    expect(calls.map((c) => c.name)).toEqual(["a.geojson"]);
    expect(queue.getSnapshot().position).toBe(1);

    // A drop while the batch runs appends and raises the total without
    // disturbing the in-flight request.
    queue.add(files("c.geojson"));
    expect(queue.getSnapshot().entries).toHaveLength(3);
    expect(calls).toHaveLength(1);

    calls[0].handlers.imported([table("a")], []);
    expect(calls.map((c) => c.name)).toEqual(["a.geojson", "b.geojson"]);
    expect(queue.getSnapshot().position).toBe(2);
    calls[1].handlers.imported([table("b")], []);
    calls[2].handlers.imported([table("c")], []);
    expect(queue.getSnapshot().settled).toBe(true);
  });

  it("accounts every terminal outcome and attributes skips to their file", () => {
    const { calls, transport } = fakeTransport();
    const settles: SettleReport[] = [];
    const stale = vi.fn();
    const queue = createUploadQueue(transport, {
      onSettled: (r) => settles.push(r),
      onListingStale: stale,
    });
    queue.add(files("good.gpkg", "bad.geojson", "flaky.csv", "tail.csv"));

    calls[0].handlers.imported(
      [table("roads"), table("rails")],
      [{ layer: "notes", reason: "no geometry" }],
    );
    calls[1].handlers.refused("Malformed file.");
    calls[2].handlers.lost();
    calls[3].handlers.imported([table("tail")], []);

    expect(settles).toHaveLength(1);
    expect(settles[0]).toMatchObject({
      files: 4,
      imported: 2,
      failed: 1,
      unconfirmed: 1,
      notStarted: 0,
      dismissed: false,
      batch: 1,
    });
    // The report names every terminal entry (outcomes outside a closed host are named, never bare
    // counts).
    expect(settles[0].entries.map((e) => [e.name, e.state])).toEqual([
      ["good.gpkg", "imported"],
      ["bad.geojson", "failed"],
      ["flaky.csv", "unconfirmed"],
      ["tail.csv", "imported"],
    ]);
    // Tables in landing order; skips carry their source file.
    expect(settles[0].tables.map((t) => t.name)).toEqual([
      "roads",
      "rails",
      "tail",
    ]);
    expect(settles[0].skips).toEqual([
      { layer: "notes", reason: "no geometry", source: "good.gpkg" },
    ]);
    // The live snapshot carries the accumulated skips too (the zone shows them while a mixed batch
    // keeps the host open).
    expect(queue.getSnapshot().skips).toEqual(settles[0].skips);
    // A lost answer asked for the authoritative refresh, once.
    expect(stale).toHaveBeenCalledTimes(1);
    // The failed and unconfirmed entries hold their own notes together
    // (the rule's accumulation): never last-only.
    const states = queue.getSnapshot().entries.map((e) => e.state);
    expect(states).toEqual(["imported", "failed", "unconfirmed", "imported"]);
  });

  it("attempts each file once and ignores a second terminal report", () => {
    const { calls, transport } = fakeTransport();
    const queue = createUploadQueue(transport);
    queue.add(files("once.csv"));
    calls[0].handlers.refused("Bad.");
    // A late duplicate verdict from the same request changes nothing.
    calls[0].handlers.imported([table("once")], []);
    expect(queue.getSnapshot().entries[0].state).toBe("failed");
    // The lost file was never re-sent: one transport call total.
    expect(calls).toHaveLength(1);
  });

  it("a batch after settlement is fresh: the old display clears", () => {
    const { calls, transport } = fakeTransport();
    const queue = createUploadQueue(transport);
    queue.add(files("fails.csv"));
    calls[0].handlers.refused("Malformed file.");
    expect(queue.getSnapshot().settled).toBe(true);

    queue.add(files("next.csv"));
    const snap = queue.getSnapshot();
    expect(snap.settled).toBe(false);
    expect(snap.entries.map((e) => e.name)).toEqual(["next.csv"]);
    expect(snap.entries.some((e) => e.state === "failed")).toBe(false);
    // The batch number moved on: an async consumer of the FIRST settle
    // can tell its report is superseded (PR round's race guard).
    expect(snap.batch).toBe(2);
  });

  it("dismissal stops queued files, keeps the active one, settles on its verdict", () => {
    const { calls, transport } = fakeTransport();
    const settles: SettleReport[] = [];
    const queue = createUploadQueue(transport, {
      onSettled: (r) => settles.push(r),
    });
    queue.add(files("active.csv", "q1.csv", "q2.csv"));
    expect(queue.dismiss()).toBe(2);
    // The stopped files are never requested.
    expect(calls).toHaveLength(1);
    expect(queue.getSnapshot().entries.map((e) => e.state)).toEqual([
      "uploading",
      "not-started",
      "not-started",
    ]);
    expect(settles).toHaveLength(0); // the active verdict is still owed

    calls[0].handlers.imported([table("active")], []);
    expect(settles).toHaveLength(1);
    expect(settles[0]).toMatchObject({
      imported: 1,
      notStarted: 2,
      dismissed: true,
    });
    // Dismissing a settled batch is a no-op, never a second settle.
    expect(queue.dismiss()).toBe(0);
    expect(settles).toHaveLength(1);
  });

  it("reset drops a settled batch but never a live request's record", () => {
    const { calls, transport } = fakeTransport();
    const queue = createUploadQueue(transport);
    queue.add(files("a.csv"));
    queue.reset(); // active — refused
    expect(queue.getSnapshot().entries).toHaveLength(1);
    calls[0].handlers.imported([table("a")], []);
    queue.reset(); // settled — drops
    expect(queue.getSnapshot().entries).toHaveLength(0);
    expect(queue.getSnapshot().settled).toBe(false);
  });
});

describe("the batch-captured import context", () => {
  it("captures the project at admission and holds it for the whole batch", () => {
    const { calls, transport } = fakeTransport();
    const queue = createUploadQueue(transport, { projectId: "p-berlin" });
    queue.add(files("a.geojson", "b.geojson"));
    // A mid-batch option change (the map moved) never redirects the
    // tail of an admitted batch — nor a mid-batch append to it.
    queue.setOptions({ projectId: "p-atlas" });
    queue.add(files("c.geojson"));
    calls[0].handlers.imported([table("a")], []);
    calls[1].handlers.imported([table("b")], []);
    calls[2].handlers.imported([table("c")], []);
    expect(calls.map((c) => c.context.projectId)).toEqual([
      "p-berlin",
      "p-berlin",
      "p-berlin",
    ]);
    // The NEXT batch captures the fresh value.
    queue.add(files("d.geojson"));
    expect(calls[3].context.projectId).toBe("p-atlas");
  });

  it("carries no project when the host set none", () => {
    const { calls, transport } = fakeTransport();
    const queue = createUploadQueue(transport);
    queue.add(files("a.csv"));
    expect(calls[0].context.projectId).toBeNull();
  });
  it("tells the host which project the running batch files into, even after the host's scope moved", () => {
    const { calls, transport } = fakeTransport();
    const queue = createUploadQueue(transport, { projectId: "p-berlin" });
    queue.add(files("a.geojson"));
    expect(queue.getSnapshot().projectId).toBe("p-berlin");
    // The host's scope moves mid-batch; an appended file still joins the
    // admitted batch, and the snapshot says where that batch files.
    queue.setOptions({ projectId: "p-atlas" });
    queue.add(files("b.geojson"));
    expect(queue.getSnapshot().projectId).toBe("p-berlin");
    expect(calls[0].context.projectId).toBe("p-berlin");
    calls[0].handlers.imported([table("a")], []);
    expect(calls[1].context.projectId).toBe("p-berlin");
    calls[1].handlers.imported([table("b")], []);
    // Settled: no running batch, no captured destination.
    expect(queue.getSnapshot().settled).toBe(true);
    expect(queue.getSnapshot().projectId).toBeNull();
    // The next batch captures the moved scope.
    queue.add(files("c.geojson"));
    expect(queue.getSnapshot().projectId).toBe("p-atlas");
    expect(calls[2].context.projectId).toBe("p-atlas");
  });
});

/**
 * The batch's column-matching steps (plan: "the batch's steps live in
 * the upload queue engine"): a landed file whose answer the mounted
 * dialog's gate holds enters a non-terminal matching state; the next
 * request waits behind it, settlement waits for it, and it resolves as
 * confirmed (the listing refresh, no second landing notice) or closed (a
 * plain table). No gate, no step: the catalog's queue and a closed
 * dialog land as today.
 */
describe("the batch's matching steps", () => {
  /** The gate the dialog registers: which of a file's tables needs the
   * step. Here by name, so the test's expectations stand apart from the
   * needs-step rule, which has its own test. */
  const holdWeak = (tables: DataTable[]) => tables.find((t) => t.name.startsWith("weak")) ?? null;

  it("a gate holds a landed file: the next request waits, the landing notice fires once, the snapshot names the files waiting behind", () => {
    const { calls, transport } = fakeTransport();
    const imported = vi.fn();
    const queue = createUploadQueue(transport, { onFileImported: imported });
    queue.registerMatchingGate(holdWeak);
    queue.add(files("weak-a.csv", "strong-b.csv", "weak-c.csv"));
    calls[0].handlers.imported([table("weak-a")], []);
    // The table landed (the notice, once) and the batch waits.
    expect(imported).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.name)).toEqual(["weak-a.csv"]);
    const snap = queue.getSnapshot();
    expect(snap.entries[0].state).toBe("matching");
    expect(snap.active).toBeNull();
    expect(snap.settled).toBe(false);
    expect(snap.position).toBe(1);
    expect(snap.matching).toEqual({ id: snap.entries[0].id, name: "weak-a.csv", table: table("weak-a"), waiting: ["strong-b.csv", "weak-c.csv"] });
  });

  it("resolving as confirmed refreshes the listing through the stale channel, never a second landing notice, and starts the next file", () => {
    const { calls, transport } = fakeTransport();
    const imported = vi.fn();
    const stale = vi.fn();
    const queue = createUploadQueue(transport, { onFileImported: imported, onListingStale: stale });
    queue.registerMatchingGate(holdWeak);
    queue.add(files("weak-a.csv", "strong-b.csv"));
    calls[0].handlers.imported([table("weak-a")], []);
    queue.resolveMatching(queue.getSnapshot().matching!.id, "confirmed");
    // The workflow host places one source node per landing notice: a confirmed step must not be a
    // second landing.
    expect(imported).toHaveBeenCalledTimes(1);
    expect(stale).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.name)).toEqual(["weak-a.csv", "strong-b.csv"]);
    expect(queue.getSnapshot().entries[0].state).toBe("imported");
    expect(queue.getSnapshot().matching).toBeNull();
  });

  it("resolving as closed starts the next file with no refresh; a closed step's file counts as imported in the account", () => {
    const { calls, transport } = fakeTransport();
    const stale = vi.fn();
    const settles: SettleReport[] = [];
    const queue = createUploadQueue(transport, { onListingStale: stale, onSettled: (r) => settles.push(r) });
    queue.registerMatchingGate(holdWeak);
    queue.add(files("weak-a.csv", "strong-b.csv"));
    calls[0].handlers.imported([table("weak-a")], []);
    queue.resolveMatching(queue.getSnapshot().matching!.id, "closed");
    expect(stale).not.toHaveBeenCalled();
    expect(calls.map((c) => c.name)).toEqual(["weak-a.csv", "strong-b.csv"]);
    calls[1].handlers.imported([table("strong-b")], []);
    expect(settles).toHaveLength(1);
    expect(settles[0]).toMatchObject({ files: 2, imported: 2, failed: 0, unconfirmed: 0, notStarted: 0, dismissed: false });
    expect(settles[0].tables.map((t) => t.name)).toEqual(["weak-a", "strong-b"]);
  });

  it("settlement waits for the last step: the clean-batch close cannot fire while a step is open (plan risk 1)", () => {
    const { calls, transport } = fakeTransport();
    const settles: SettleReport[] = [];
    const queue = createUploadQueue(transport, { onSettled: (r) => settles.push(r) });
    queue.registerMatchingGate(holdWeak);
    queue.add(files("strong-a.csv", "weak-b.csv"));
    calls[0].handlers.imported([table("strong-a")], []);
    calls[1].handlers.imported([table("weak-b")], []);
    expect(queue.getSnapshot().entries.map((e) => e.state)).toEqual(["imported", "matching"]);
    expect(settles).toHaveLength(0);
    expect(queue.getSnapshot().settled).toBe(false);
    queue.resolveMatching(queue.getSnapshot().matching!.id, "confirmed");
    expect(settles).toHaveLength(1);
    expect(settles[0]).toMatchObject({ files: 2, imported: 2 });
    expect(queue.getSnapshot().settled).toBe(true);
  });

  it("a gateless landing lands plain (the catalog's queue, a dismissed dialog): an answer released before any gate is registered is never held, one released after is", () => {
    // The bypass check only: the Data page's
    // own drop-to-dialog ordering is the journey's to prove.
    const { calls, transport } = fakeTransport();
    const queue = createUploadQueue(transport);
    queue.add(files("weak-a.csv", "weak-b.csv"));
    calls[0].handlers.imported([table("weak-a")], []);
    expect(queue.getSnapshot().entries[0].state).toBe("imported");
    expect(calls.map((c) => c.name)).toEqual(["weak-a.csv", "weak-b.csv"]);
    queue.registerMatchingGate(holdWeak);
    calls[1].handlers.imported([table("weak-b")], []);
    expect(queue.getSnapshot().entries[1].state).toBe("matching");
    expect(queue.getSnapshot().settled).toBe(false);
  });

  it("a gate that holds nothing lands the file as today", () => {
    const { calls, transport } = fakeTransport();
    const settles: SettleReport[] = [];
    const queue = createUploadQueue(transport, { onSettled: (r) => settles.push(r) });
    queue.registerMatchingGate(holdWeak);
    queue.add(files("districts.geojson"));
    calls[0].handlers.imported([table("districts")], []);
    expect(queue.getSnapshot().entries[0].state).toBe("imported");
    expect(queue.getSnapshot().matching).toBeNull();
    expect(settles).toHaveLength(1);
  });

  it("dismissal stops the queued files and resolves the pending step plain, with the not-started account", () => {
    const { calls, transport } = fakeTransport();
    const stale = vi.fn();
    const settles: SettleReport[] = [];
    const queue = createUploadQueue(transport, { onListingStale: stale, onSettled: (r) => settles.push(r) });
    queue.registerMatchingGate(holdWeak);
    queue.add(files("weak-a.csv", "strong-b.csv", "weak-c.csv"));
    calls[0].handlers.imported([table("weak-a")], []);
    expect(queue.dismiss()).toBe(2);
    // Nothing behind the step was requested, nothing was written for
    // the closed step, and the batch settled with the dismissal's account.
    expect(calls).toHaveLength(1);
    expect(stale).not.toHaveBeenCalled();
    expect(queue.getSnapshot().entries.map((e) => e.state)).toEqual(["imported", "not-started", "not-started"]);
    expect(queue.getSnapshot().matching).toBeNull();
    expect(settles).toHaveLength(1);
    expect(settles[0]).toMatchObject({ imported: 1, notStarted: 2, dismissed: true });
  });

  it("releasing the gate resolves a pending step plain, so nothing waits behind a dialog that is gone (plan risk 2)", () => {
    const { calls, transport } = fakeTransport();
    const queue = createUploadQueue(transport);
    const release = queue.registerMatchingGate(holdWeak);
    queue.add(files("weak-a.csv", "strong-b.csv"));
    calls[0].handlers.imported([table("weak-a")], []);
    expect(queue.getSnapshot().entries[0].state).toBe("matching");
    release();
    expect(queue.getSnapshot().entries[0].state).toBe("imported");
    expect(queue.getSnapshot().matching).toBeNull();
    // The batch went on without the gate: the next file was requested
    // and, landing, is not held.
    expect(calls.map((c) => c.name)).toEqual(["weak-a.csv", "strong-b.csv"]);
    calls[1].handlers.imported([table("weak-b")], []);
    expect(queue.getSnapshot().entries[1].state).toBe("imported");
  });

  it("releasing the gate with no step pending leaves an active upload to answer: a batch dismissed mid-upload settles on that upload's own outcome", () => {
    const { calls, transport } = fakeTransport();
    const settles: SettleReport[] = [];
    const queue = createUploadQueue(transport, { onSettled: (r) => settles.push(r) });
    const release = queue.registerMatchingGate(holdWeak);
    queue.add(files("strong-a.csv", "strong-b.csv"));
    // The host closes during the first upload: the dismissal stops the
    // file behind and keeps the active request, then the dialog's
    // unmount releases the gate.
    expect(queue.dismiss()).toBe(1);
    release();
    // Nothing has settled: the active request has not answered.
    expect(settles).toHaveLength(0);
    expect(queue.getSnapshot().settled).toBe(false);
    expect(queue.getSnapshot().entries.map((e) => e.state)).toEqual(["uploading", "not-started"]);
    calls[0].handlers.imported([table("strong-a")], []);
    // The batch settles once, on the upload's real outcome: the
    // import counted, no entry stranded as uploading.
    expect(settles).toHaveLength(1);
    expect(settles[0]).toMatchObject({ files: 2, imported: 1, notStarted: 1, dismissed: true });
    expect(settles[0].entries.map((e) => e.state)).toEqual(["imported", "not-started"]);
  });

  it("releasing the gate while an upload is active starts nothing: the file behind stays queued until the active one answers, and the note then names it (browser item b: the drop-anywhere batch under the dialog's StrictMode rehearsal of the gate)", () => {
    const { calls, transport } = fakeTransport();
    const queue = createUploadQueue(transport);
    // The Data page's drop handler starts the batch, then opens the
    // dialog, whose gate effect is run, cleaned up and run again in
    // development (React's StrictMode). The rehearsal must not touch the
    // running batch.
    queue.add(files("weak-a.csv", "strong-b.csv"));
    const release = queue.registerMatchingGate(holdWeak);
    release();
    queue.registerMatchingGate(holdWeak);
    expect(calls.map((c) => c.name)).toEqual(["weak-a.csv"]);
    expect(queue.getSnapshot().entries.map((e) => e.state)).toEqual(["uploading", "queued"]);
    calls[0].handlers.imported([table("weak-a")], []);
    expect(queue.getSnapshot().matching).toMatchObject({ name: "weak-a.csv", waiting: ["strong-b.csv"] });
    expect(calls).toHaveLength(1);
  });

  it("files appended mid-step join the batch and wait; the note follows the snapshot (plan risk 9)", () => {
    const { calls, transport } = fakeTransport();
    const queue = createUploadQueue(transport);
    queue.registerMatchingGate(holdWeak);
    queue.add(files("weak-a.csv"));
    calls[0].handlers.imported([table("weak-a")], []);
    expect(queue.getSnapshot().matching!.waiting).toEqual([]);
    queue.add(files("late.csv"));
    // The appended file waits behind the step rather than starting.
    expect(calls).toHaveLength(1);
    expect(queue.getSnapshot().matching!.waiting).toEqual(["late.csv"]);
    queue.resolveMatching(queue.getSnapshot().matching!.id, "closed");
    expect(calls.map((c) => c.name)).toEqual(["weak-a.csv", "late.csv"]);
  });

  it("a resolution for a step no longer pending writes nothing to the batch; a confirmed one still refreshes the listing", () => {
    const { calls, transport } = fakeTransport();
    const stale = vi.fn();
    const queue = createUploadQueue(transport, { onListingStale: stale });
    queue.registerMatchingGate(holdWeak);
    queue.add(files("weak-a.csv"));
    calls[0].handlers.imported([table("weak-a")], []);
    const id = queue.getSnapshot().matching!.id;
    queue.dismiss(); // the host closed: the step resolved plain
    queue.resolveMatching(id, "confirmed"); // the set answered after all
    expect(queue.getSnapshot().entries[0].state).toBe("imported");
    expect(stale).toHaveBeenCalledTimes(1);
    queue.resolveMatching(id, "closed");
    expect(stale).toHaveBeenCalledTimes(1);
  });
});
