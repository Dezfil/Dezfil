import { describe, expect, it } from "vitest";
import { ProjectHomeReader, type HomeField, type HomeVisit } from "./home-reader";
import type { HomeState, HomeWorld, ProjectRecordWire } from "./home-read";

const T0 = "2026-09-06T10:00:00.000Z";
const T1 = "2026-09-06T10:01:00.000Z";
const T2 = "2026-09-06T10:02:00.000Z";
const record = (patch: Partial<ProjectRecordWire> = {}): ProjectRecordWire => ({
  id: "a", name: "Original", note: "Old note", createdAt: T0, updatedAt: T0, ...patch,
});
const world = (patch: Partial<HomeWorld> = {}): HomeWorld => ({
  record: record(), maps: [], workflows: [], tables: [],
  names: new Map(), lastRuns: new Map(), ...patch,
});
const kinds = ["maps", "workflows", "tables"] as const;
type Kind = typeof kinds[number];
// Only identities matter to this coordinator; the renderer's other listing
// properties are covered by the existing project-screen journeys.
const members = (kind: Kind, ids: string[]): Partial<HomeWorld> => ({
  [kind]: ids.map((id) => ({ id })),
});
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness() {
  const requests: { id: string; release: (state: HomeState) => void }[] = [];
  const reader = new ProjectHomeReader((id) => new Promise((release) => {
    requests.push({ id, release });
  }));
  const visit: HomeVisit = { id: "a" };
  const shown = () => {
    const state = reader.getSnapshot().state;
    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("Expected a ready home");
    return state.value;
  };
  const release = async (index: number, value: HomeWorld) => {
    expect(requests[index], `read ${index} was issued`).toBeDefined();
    requests[index].release({ status: "ready", value });
    await flush();
  };
  const ready = async (value = world()) => {
    const loaded = reader.activate(visit);
    await release(0, value);
    expect(await loaded).toBe(true);
  };
  return { reader, visit, requests, shown, release, ready };
}

describe("baseline-red", () => {
  it("C1 retains a confirmed rename across a held refresh", async () => {
    const h = harness(); await h.ready();
    const refresh = h.reader.refresh(h.visit);
    h.reader.acceptSave(h.reader.beginSave(h.visit, "name"), record({ name: "Saved new name", updatedAt: T1 }));
    expect(h.shown().record.name).toBe("Saved new name");
    await h.release(1, world());
    expect(h.shown().record.name).toBe("Saved new name");
    if (h.requests.length > 2) await h.release(2, world({ record: record({ name: "Saved new name", updatedAt: T1 }) }));
    expect(await refresh).toBe(true);
  });

  it.each(["Saved note", null])("C2 retains confirmed note %s across a held refresh", async (note) => {
    const h = harness(); await h.ready();
    const refresh = h.reader.refresh(h.visit);
    h.reader.acceptSave(h.reader.beginSave(h.visit, "note"), record({ note, updatedAt: T1 }));
    expect(h.shown().record.note).toBe(note);
    await h.release(1, world());
    expect(h.shown().record.note).toBe(note);
    if (h.requests.length > 2) await h.release(2, world({ record: record({ note, updatedAt: T1 }) }));
    expect(await refresh).toBe(true);
  });

  it.each(["name-first", "note-first"])("C3 merges independent echoes %s and keeps the newest timestamp", async (order) => {
    const h = harness(); await h.ready();
    const name = h.reader.beginSave(h.visit, "name");
    const note = h.reader.beginSave(h.visit, "note");
    const replies = [
      () => h.reader.acceptSave(name, record({ name: "New name", updatedAt: T1 })),
      () => h.reader.acceptSave(note, record({ note: "New note", updatedAt: T2 })),
    ];
    if (order === "note-first") replies.reverse();
    expect(replies[0]()).toBe(true);
    expect(h.shown().record.updatedAt).toBe(order === "name-first" ? T1 : T2);
    expect(replies[1]()).toBe(true);
    expect(h.shown().record).toEqual(record({ name: "New name", note: "New note", updatedAt: T2 }));
  });

  it.each<HomeField>(["name", "note"])("C3 rejects an older %s reply after a later accepted edit", async (field) => {
    const h = harness(); await h.ready();
    const first = h.reader.beginSave(h.visit, field);
    const second = h.reader.beginSave(h.visit, field);
    h.reader.acceptSave(second, record({ [field]: "Second", updatedAt: T2 }));
    h.reader.acceptSave(first, record({ [field]: "First", updatedAt: T1 }));
    expect(h.shown().record[field]).toBe("Second");
    expect(h.shown().record.updatedAt).toBe(T2);
  });

  it.each(kinds)("C4 keeps newer %s additions and removals when reads finish backwards", async (kind) => {
    const h = harness(); await h.ready(world(members(kind, ["kept", "removed"])));
    const older = h.reader.confirmMembership(h.visit);
    const newer = h.reader.confirmMembership(h.visit);
    await h.release(2, world(members(kind, ["kept", "added"])));
    expect(h.shown()[kind].map((m) => m.id)).toEqual(["kept", "added"]);
    await h.release(1, world(members(kind, ["kept", "removed"])));
    expect(h.shown()[kind].map((m) => m.id)).toEqual(["kept", "added"]);
    expect(await newer).toBe(true);
    expect(await older).toBe(true);
  });

  it.each(["before", "after"])("C5 rejects A save replies %s B loads", async (when) => {
    const h = harness(); await h.ready();
    const save = h.reader.beginSave(h.visit, "name");
    const b = { id: "b" };
    h.reader.dispose(h.visit);
    const loaded = h.reader.activate(b);
    if (when === "after") await h.release(1, world({ record: record({ id: "b", name: "Project B" }) }));
    h.reader.acceptSave(save, record({ name: "Late A" }));
    if (when === "before") {
      expect(h.reader.getSnapshot().state.status).toBe("pending");
      await h.release(1, world({ record: record({ id: "b", name: "Project B" }) }));
    }
    expect(await loaded).toBe(true);
    expect(h.shown().record).toEqual(record({ id: "b", name: "Project B" }));
    expect(h.reader.ownsSave(save)).toBe(false);
  });
});

describe("seeded guards", () => {
  it("C3 accepts a cleared null note while preserving an independent rename", async () => {
    const h = harness(); await h.ready();
    const note = h.reader.beginSave(h.visit, "note");
    h.reader.acceptSave(h.reader.beginSave(h.visit, "name"), record({ name: "New name", updatedAt: T1 }));
    h.reader.acceptSave(note, record({ note: null, updatedAt: T2 }));
    expect(h.shown().record).toEqual(record({ name: "New name", note: null, updatedAt: T2 }));
  });

  it.each(kinds)("C4 fences obsolete %s at membership confirmation while the follow-up is pending", async (kind) => {
    const h = harness(); await h.ready(world(members(kind, ["shown"])));
    const held = h.reader.refresh(h.visit);
    const changed = h.reader.confirmMembership(h.visit);
    await h.release(1, world(members(kind, ["obsolete"])));
    expect(h.shown()[kind].map((m) => m.id)).toEqual(["shown"]);
    await h.release(2, world(members(kind, ["confirmed"])));
    expect(h.shown()[kind].map((m) => m.id)).toEqual(["confirmed"]);
    expect(await held).toBe(true);
    expect(await changed).toBe(true);
  });

  it.each(kinds.flatMap((kind) => (["name", "note"] as const).map((field) => [field, kind] as const)))("C4 replaces a membership follow-up superseded by a %s save for %s and settles only on installation", async (field, kind) => {
    const h = harness(); await h.ready(world(members(kind, ["removed"])));
    let settled: boolean | undefined;
    const changed = h.reader.confirmMembership(h.visit).then((ok) => { settled = ok; return ok; });
    h.reader.acceptSave(h.reader.beginSave(h.visit, field), record({ [field]: "Confirmed", updatedAt: T1 }));
    await h.release(1, world(members(kind, ["added"])));
    expect(h.shown().record[field]).toBe("Confirmed");
    expect(settled).toBeUndefined();
    expect(h.requests).toHaveLength(3);
    await h.release(2, world({ ...members(kind, ["added"]), record: record({ [field]: "Confirmed", updatedAt: T1 }) }));
    expect(await changed).toBe(true);
    expect(h.shown().record[field]).toBe("Confirmed");
    expect(h.shown()[kind].map((m) => m.id)).toEqual(["added"]);
  });

  it.each(["before", "after"])("C5 rejects A initial and quiet reads %s B loads", async (when) => {
    for (const quiet of [false, true]) {
      const h = harness();
      const old = quiet ? (await h.ready(), h.reader.refresh(h.visit)) : h.reader.activate(h.visit);
      const index = quiet ? 1 : 0;
      h.reader.dispose(h.visit);
      const b = { id: "b" };
      const loaded = h.reader.activate(b);
      const bWorld = world({ record: record({ id: "b", name: "Project B" }) });
      if (when === "after") await h.release(index + 1, bWorld);
      await h.release(index, world({ record: record({ name: "Late A read" }) }));
      if (when === "before") {
        expect(h.reader.getSnapshot().state.status).toBe("pending");
        await h.release(index + 1, bWorld);
      }
      expect(await loaded).toBe(true);
      expect(h.shown().record.name).toBe("Project B");
      expect(await old).toBe(false);
    }
  });

  it("C5 rejects reads and saves from an earlier A visit after A to B to A in one reader", async () => {
    const h = harness(); await h.ready();
    const oldRead = h.reader.refresh(h.visit);
    const oldSave = h.reader.beginSave(h.visit, "note");
    h.reader.dispose(h.visit);
    const b = { id: "b" };
    const bRead = h.reader.activate(b);
    await h.release(2, world({ record: record({ id: "b", name: "B" }) }));
    expect(await bRead).toBe(true);
    h.reader.dispose(b);
    const returned = { id: "a" };
    const aRead = h.reader.activate(returned);
    await h.release(3, world({ record: record({ name: "Current A", note: "Current note" }) }));
    expect(await aRead).toBe(true);
    await h.release(1, world({ record: record({ name: "Earlier visit" }) }));
    h.reader.acceptSave(oldSave, record({ note: "Earlier save" }));
    expect(h.shown().record).toEqual(record({ name: "Current A", note: "Current note" }));
    expect(await oldRead).toBe(false);
    expect(h.reader.ownsSave(oldSave)).toBe(false);
  });

  it("C5 rejects saves across disposal and reactivation of the same visit token", async () => {
    const h = harness(); await h.ready();
    const save = h.reader.beginSave(h.visit, "name");
    h.reader.dispose(h.visit);
    expect(h.reader.ownsSave(save)).toBe(false);
    const loaded = h.reader.activate(h.visit);
    await h.release(1, world({ record: record({ name: "Remounted" }) }));
    expect(await loaded).toBe(true);
    h.reader.acceptSave(save, record({ name: "Disposed" }));
    expect(h.shown().record.name).toBe("Remounted");
  });

  it("C6 ordinary refresh replaces confirmed fields and all members without a pending flash", async () => {
    const h = harness(); await h.ready(world({ ...members("maps", ["old-map"]), ...members("workflows", ["old-workflow"]), ...members("tables", ["old-table"]) }));
    h.reader.acceptSave(h.reader.beginSave(h.visit, "name"), record({ name: "Local name", updatedAt: T1 }));
    h.reader.acceptSave(h.reader.beginSave(h.visit, "note"), record({ note: "Local note", updatedAt: T2 }));
    const states: string[] = [];
    const unsubscribe = h.reader.subscribe(() => states.push(h.reader.getSnapshot().state.status));
    const refreshed = h.reader.refresh(h.visit);
    expect(h.reader.getSnapshot().state.status).toBe("ready");
    await h.release(1, world({ record: record({ name: "Server name", note: "Server note" }), ...members("maps", ["new-map"]), ...members("workflows", ["new-workflow"]), ...members("tables", ["new-table"]) }));
    expect(await refreshed).toBe(true);
    expect(h.shown().record.name).toBe("Server name");
    expect(h.shown().record.note).toBe("Server note");
    expect(h.shown().maps.map((m) => m.id)).toEqual(["new-map"]);
    expect(h.shown().workflows.map((m) => m.id)).toEqual(["new-workflow"]);
    expect(h.shown().tables.map((m) => m.id)).toEqual(["new-table"]);
    expect(states).not.toContain("pending");
    unsubscribe();
  });

  it.each<HomeState>([{ status: "failed", error: "offline" }, { status: "missing", message: "gone" }])("C6 quiet $status retains the ready home and recovers", async (failure) => {
    const h = harness(); await h.ready();
    const failed = h.reader.refresh(h.visit);
    h.requests[1].release(failure);
    expect(await failed).toBe(false);
    expect(h.shown().record.name).toBe("Original");
    const recovery = h.reader.refresh(h.visit);
    await h.release(2, world({ record: record({ name: "Recovered" }) }));
    expect(await recovery).toBe(true);
    expect(h.shown().record.name).toBe("Recovered");
  });

  it("C6 a superseded failure waits for the current read instead of reporting stale", async () => {
    const h = harness(); await h.ready();
    let settled: boolean | undefined;
    const older = h.reader.refresh(h.visit).then((ok) => { settled = ok; return ok; });
    const newer = h.reader.refresh(h.visit);
    h.requests[1].release({ status: "failed", error: "old failure" });
    await flush();
    expect(settled).toBeUndefined();
    await h.release(2, world({ record: record({ name: "Current" }) }));
    expect(await older).toBe(true);
    expect(await newer).toBe(true);
    expect(h.shown().record.name).toBe("Current");
  });


});


describe("green controls", () => {
  it("C3 an unconfirmed later save does not block an earlier confirmation or an ordinary read", async () => {
    const h = harness(); await h.ready();
    const first = h.reader.beginSave(h.visit, "name");
    const later = h.reader.beginSave(h.visit, "name");
    h.reader.acceptSave(first, record({ name: "Accepted first" }));
    expect(h.shown().record.name).toBe("Accepted first");
    expect(h.reader.ownsSave(later)).toBe(true);
    const refresh = h.reader.refresh(h.visit);
    h.reader.beginSave(h.visit, "note"); // User draft/request, no confirmation.
    await h.release(1, world({ record: record({ name: "Server read" }) }));
    expect(await refresh).toBe(true);
    expect(h.shown().record.name).toBe("Server read");
    expect(h.requests).toHaveLength(2);
  });

  it("C4 coalesces replacement reads for independent confirmations in one turn", async () => {
    const h = harness(); await h.ready();
    const refresh = h.reader.confirmMembership(h.visit);
    h.reader.acceptSave(h.reader.beginSave(h.visit, "name"), record({ name: "Saved name", updatedAt: T1 }));
    h.reader.acceptSave(h.reader.beginSave(h.visit, "note"), record({ note: "Saved note", updatedAt: T2 }));
    await flush();
    expect(h.requests).toHaveLength(3);
    await h.release(2, world({ record: record({ name: "Saved name", note: "Saved note", updatedAt: T2 }), ...members("tables", ["new-table"]) }));
    expect(await refresh).toBe(true);
    await h.release(1, world());
    expect(h.shown().record).toEqual(record({ name: "Saved name", note: "Saved note", updatedAt: T2 }));
    expect(h.shown().tables.map((m) => m.id)).toEqual(["new-table"]);
  });

  it("C5 disposal settles waiting callers without waiting for transport", async () => {
    const h = harness(); await h.ready();
    const refresh = h.reader.refresh(h.visit);
    h.reader.dispose(h.visit);
    let settled: boolean | undefined;
    void refresh.then((ok) => { settled = ok; });
    await flush();
    expect(settled).toBe(false);
    expect(await h.reader.refresh(h.visit)).toBe(false);
    expect(await h.reader.retry(h.visit)).toBe(false);
    expect(await h.reader.confirmMembership(h.visit)).toBe(false);
    expect(h.requests).toHaveLength(2);
  });

  it("C6 a current replacement failure settles all callers false and a later refresh recovers", async () => {
    const h = harness(); await h.ready();
    const older = h.reader.refresh(h.visit);
    const changed = h.reader.confirmMembership(h.visit);
    h.reader.acceptSave(h.reader.beginSave(h.visit, "note"), record({ note: "Saved note", updatedAt: T1 }));
    await flush();
    expect(h.requests).toHaveLength(4);
    h.requests[3].release({ status: "failed", error: "current failure" });
    expect(await older).toBe(false);
    expect(await changed).toBe(false);
    await h.release(1, world({ record: record({ name: "Old transport success" }) }));
    await h.release(2, world());
    expect(h.shown().record.note).toBe("Saved note");
    expect(h.shown().record.name).toBe("Original");
    const recovery = h.reader.refresh(h.visit);
    await h.release(4, world({ record: record({ name: "Recovery", note: "Saved note" }) }));
    expect(await recovery).toBe(true);
    expect(h.shown().record.name).toBe("Recovery");
  });

  it("C6 genuine initial failure is visible and retry is owned against earlier reads", async () => {
    const h = harness();
    const initial = h.reader.activate(h.visit);
    h.requests[0].release({ status: "failed", error: "initial failure" });
    expect(await initial).toBe(false);
    expect(h.reader.getSnapshot().state).toEqual({ status: "failed", error: "initial failure" });
    const older = h.reader.retry(h.visit);
    const newer = h.reader.retry(h.visit);
    await h.release(2, world({ record: record({ name: "Retry success" }) }));
    await h.release(1, world({ record: record({ name: "Old retry" }) }));
    expect(await newer).toBe(true);
    expect(h.shown().record.name).toBe("Retry success");
    await older;
  });
});
