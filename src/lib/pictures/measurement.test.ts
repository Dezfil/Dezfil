import { expect, it } from "vitest";
import { capacityEvents, firstMeasurement, foregroundLimits, assertForegroundInterruption, activeRenders } from "../../../scripts/pictures-measurement.mjs";
it("capacity observations reject rerenders, missing work and legacy work overtaking missing work", () => {
  const maps = [{ id: "m", group: "missing" }, { id: "o", group: "old" }, { id: "c", group: "current" }];
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
it("whole-attempt timing includes the second appearance and publication, and refuses a hidden retry", () => {
  const maps = Array.from({ length: 20 }, (_, i) => ({ id: String(i), group: "missing", pair: i % 2 === 1 }));
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
