import { expect, it } from "vitest";
import { capacityEvents, firstMeasurement, foregroundLimits, assertForegroundInterruption, activeRenders, assertBacklogSample, measureBacklog, assertRestartInterrupted } from "../../../scripts/pictures-measurement.mjs";
it("capacity observations reject rerenders, missing work and legacy work overtaking missing work", () => {
  const maps = [{ id: "m", group: "missing", drawingChangedAt: 2 }, { id: "o", group: "old", drawingChangedAt: 3 }, { id: "c", group: "current" }];
  const event = (mapId: string) => ({ kind: "published", mapId });
  expect(capacityEvents(maps, [event("m"), event("o")])).toHaveLength(2);
  expect(() => capacityEvents(maps, [event("o"), event("m")])).toThrow("overtook");
  expect(() => capacityEvents(maps, [event("m")])).toThrow("never published");
  expect(() => capacityEvents(maps, [event("m"), event("o"), event("m")])).toThrow("twice");
  expect(() => capacityEvents(maps, [event("c")])).toThrow("already-current");
});

const foregroundFixture = () => {
  const events: { kind: string; mapId?: string; background?: boolean; at: number; pid: number }[] = [];
  const samples = { export: [] as object[], check: [] as object[] };
  for (const kind of ["export", "check"] as const) for (let i = 0; i < 5; i++) {
    const at = events.length * 1000;
    events.push({ kind: "admitted", background: true, mapId: "background", at, pid: 1 });
    samples[kind].push({ mapId: "foreground", eventOffset: events.length, requestedAt: at + 10, answeredAt: at + 1010 + i * 100 });
    events.push({ kind: "admitted", background: false, mapId: "foreground", at: at + 20 + i, pid: 1 });
    events.push({ kind: "released", background: false, mapId: "foreground", at: at + 1000, pid: 1 });
    events.push({ kind: "released", background: true, mapId: "background", at: at + 2000, pid: 1 });
  }
  return { events, samples };
};

it("freezes five overlapped two-slot samples at their 90th percentile times 1.5", () => {
  const { samples, events } = foregroundFixture();
  expect(foregroundLimits(samples, events, 1500, 2)).toEqual({ exportStartMs: 21, checkAnswerMs: 2100 });
  expect(() => foregroundLimits({ ...samples, export: samples.export.slice(1) }, events, 1500, 2)).toThrow("five");
  expect(() => foregroundLimits(samples, events, 1500, 1)).toThrow("two slots");
  expect(() => foregroundLimits(samples, events, 700, 2)).toThrow("margin");
});

it("refuses a foreground limit measured with nothing in flight or after the background slot was released", () => {
  const { samples, events } = foregroundFixture();
  expect(() => foregroundLimits(samples, events.map(event => event.background ? { ...event, kind: "ignored" } : event), 1500, 2)).toThrow("background render");
  const released = [...events];
  released[0] = { ...released[0], kind: "released" };
  expect(() => foregroundLimits(samples, released, 1500, 2)).toThrow("background render");
  const restarted = [...events];
  restarted[0] = { kind: "boot", at: 0, pid: 2 };
  expect(() => foregroundLimits(samples, restarted, 1500, 2)).toThrow("background render");
  expect(activeRenders(events)).toEqual([]);
});

it("refuses calibration that queues until the original background render has ended", () => {
  const { samples, events } = foregroundFixture();
  const queued = [...events];
  // The request arrived during work, but admission waited for its slot.
  queued[1] = { kind: "released", background: true, mapId: "background", at: 15, pid: 1 };
  queued[2] = { kind: "admitted", background: false, mapId: "foreground", at: 20, pid: 1 };
  expect(() => foregroundLimits(samples, queued, 1500, 2)).toThrow("same background render");
});

it("requires a real one-slot interruption and enforces the picture budget for admission", () => {
  const sample = { mapId: "person", eventOffset: 1, requestedAt: 10, answeredAt: 100 };
  const events = [
    { kind: "admitted", mapId: "background", background: true, at: 0, pid: 1 },
    { kind: "interrupted", mapId: "background", at: 11, pid: 1 },
    { kind: "released", mapId: "background", background: true, at: 12, pid: 1 },
    { kind: "admitted", mapId: "person", background: false, at: 13, pid: 1 },
  ];
  expect(() => assertForegroundInterruption(sample, events, 30)).not.toThrow();
  expect(() => assertForegroundInterruption(sample, events.filter(event => event.kind !== "interrupted"), 30)).toThrow("interrupt");
  expect(() => assertForegroundInterruption(sample, events, 2)).toThrow("budget");
});

it("refuses backlog samples before background work, after release, or outside their progress window", () => {
  const maps = Array.from({ length: 300 }, (_, i) => ({ id: String(i), drawingChangedAt: -i, group: "missing" }));
  const sample = { mapId: "person", eventOffset: 1, requestedAt: 10, answeredAt: 100 };
  const admission = { kind: "admitted", mapId: "299", background: true, at: 0, pid: 1 };
  const person = { kind: "admitted", mapId: "person", background: false, at: 12, pid: 1 };
  expect(assertBacklogSample(maps, [admission, person], sample, 0)).toMatchObject({ publications: 0 });
  expect(() => assertBacklogSample(maps, [person], { ...sample, eventOffset: 0 }, 0)).toThrow("background render");
  const released = { ...admission, kind: "released", at: 5 };
  expect(() => assertBacklogSample(maps, [admission, released, person], { ...sample, eventOffset: 2 }, 0)).toThrow("background render");
  expect(() => assertBacklogSample(maps, [admission, person], sample, 1)).toThrow("progress window");
  const late = maps.slice(0, 60).map(map => ({ kind: "published", mapId: map.id, at: 0, pid: 1 }));
  expect(() => assertBacklogSample(maps, [...late, admission, person], { ...sample, eventOffset: 61 }, 0)).toThrow("progress window");
  expect(() => assertBacklogSample(maps, [{ ...admission, mapId: "unrelated" }, person], sample, 0)).toThrow("pending fixture map");
});

it.each(["missing", "mixed"])("spreads five foreground pairs across the %s backlog and restarts halfway when required", async kind => {
  const maps = Array.from({ length: 300 }, (_, i) => ({ id: String(i), drawingChangedAt: -i, group: kind === "missing" || i < 100 ? "missing" : i < 200 ? "old" : "current" }));
  const pending = maps.filter(map => map.group !== "current");
  const events: { kind: string; mapId?: string; background?: boolean; at: number; pid: number }[] = [];
  let publications = 0, clock = 0, pid = 1;
  const emit = (kind: string, mapId: string, background?: boolean) => events.push({ kind, mapId, background, at: ++clock, pid });
  const received: { kind: string; publications: number }[] = [], restarts: number[] = [];
  await measureBacklog({ maps, events: () => [...events], limits: { exportStartMs: 2, checkAnswerMs: 10 },
    foreground: async () => {
      expect(activeRenders(events)).toHaveLength(1);
      const sample = { mapId: "person", eventOffset: events.length, requestedAt: ++clock, answeredAt: 0 };
      emit("admitted", "person", false); emit("released", "person", false);
      sample.answeredAt = ++clock;
      return sample;
    },
    poll: async () => {
      if (activeRenders(events).length) { emit("released", String(publications), true); emit("published", String(publications++)); }
      if (publications < pending.length) emit("admitted", String(publications), true);
    },
    restart: kind === "mixed" ? async (sample: { publications: number }) => { restarts.push(sample.publications); events.push({ kind: "boot", at: ++clock, pid: ++pid }); } : undefined,
    record: (operation: string, sample: { eventOffset: number }) => received.push({ kind: operation, publications: capacityEvents(maps, events.slice(0, sample.eventOffset), false).length }),
  });
  expect(received).toEqual(Array.from({ length: 5 }, (_, i) => [
    { kind: "export", publications: i * pending.length / 5 }, { kind: "check", publications: i * pending.length / 5 },
  ]).flat());
  expect(restarts).toEqual(kind === "mixed" ? [100] : []);
});

it.each(["export", "check"])("records the failing backlog sample before enforcing its frozen %s limit", async operation => {
  const maps = Array.from({ length: 300 }, (_, i) => ({ id: String(i), drawingChangedAt: -i, group: "missing" }));
  const events = [{ kind: "admitted", mapId: "0", background: true, at: 0, pid: 1 }];
  const recorded: unknown[] = [];
  await expect(measureBacklog({ maps, events: () => events, limits: { exportStartMs: operation === "export" ? 1 : 100, checkAnswerMs: 10 },
    foreground: async () => {
      const sample = { mapId: "person", eventOffset: events.length, requestedAt: 1, answeredAt: 100 };
      events.push({ kind: "admitted", mapId: "person", background: false, at: 50, pid: 1 });
      events.push({ kind: "released", mapId: "person", background: false, at: 99, pid: 1 });
      return sample;
    }, poll: async () => {}, record: (_kind: string, sample: unknown) => recorded.push(sample),
  })).rejects.toThrow(operation === "export" ? "export start" : "Foreground check");
  expect(recorded).toHaveLength(operation === "export" ? 1 : 2);
});
it("whole-attempt timing includes the second appearance and publication, and refuses a hidden retry", () => {
  const maps = Array.from({ length: 20 }, (_, i) => ({ id: String(i), drawingChangedAt: -i, group: "missing", pair: i % 2 === 1 }));
  const events = maps.flatMap(map => [
    { kind: "admitted", background: true, mapId: map.id, monotonicMs: 100, pid: 1 },
    { kind: "released", background: true, mapId: map.id, monotonicMs: 150, pid: 1 },
    ...(map.pair ? [{ kind: "admitted", background: true, mapId: map.id, monotonicMs: 180, pid: 1 },
      { kind: "released", background: true, mapId: map.id, monotonicMs: 250, pid: 1 }] : []),
    { kind: "published", mapId: map.id, monotonicMs: map.pair ? 300 : 200, pid: 1 },
  ]);
  expect(firstMeasurement(maps, events)).toMatchObject({ single: { count: 10, p90Ms: 100 }, pair: { count: 10, p90Ms: 200 }, all: { p90Ms: 200 } });
  expect(() => firstMeasurement(maps, [...events, events[0]])).toThrow("repeated appearance");
});

it("rejects the seeded defect of older missing pictures publishing ahead of newer ones", () => {
  const maps = [
    { id: "older", group: "missing", drawingChangedAt: 1 },
    { id: "newer", group: "missing", drawingChangedAt: 2 },
  ];
  const event = (mapId: string) => ({ kind: "published", mapId });
  expect(() => capacityEvents(maps, [event("older"), event("newer")])).toThrow("Recency order");
  expect(capacityEvents(maps, [event("newer"), event("older")])).toHaveLength(2);
});

it("rejects a seeded graceful drain and proves the interrupted map resumes and publishes once", () => {
  const admission = { kind: "admitted", mapId: "old", background: true, pid: 1 };
  const sample = { admissionIndex: 1, eventOffset: 2 };
  const events = [
    { kind: "boot", pid: 1 }, admission,
    { kind: "boot", pid: 2 }, { ...admission, pid: 2 },
    { kind: "released", mapId: "old", background: true, pid: 2 },
    { kind: "published", mapId: "old", pid: 2 },
  ];
  expect(assertRestartInterrupted(sample, events)).toMatchObject({ mapId: "old", oldPid: 1, newPid: 2 });
  const drained = [...events.slice(0, 2), { ...admission, kind: "released" }, ...events.slice(2)];
  expect(() => assertRestartInterrupted(sample, drained)).toThrow("finished before restart");
  expect(() => assertRestartInterrupted({ ...sample, eventOffset: 3 }, drained)).toThrow("no render in flight");
  expect(() => assertRestartInterrupted(sample, events.slice(0, 3))).toThrow("never resumed");
  expect(() => assertRestartInterrupted(sample, [...events, events.at(-1)!])).toThrow("exactly once");
});
