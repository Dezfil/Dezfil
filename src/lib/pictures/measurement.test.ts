import { expect, it } from "vitest";
import { capacityEvents, firstMeasurement } from "../../../scripts/pictures-measurement.mjs";
it("capacity observations reject rerenders, missing work and legacy work overtaking missing work", () => {
  const maps = [{ id: "m", group: "missing" }, { id: "o", group: "old" }, { id: "c", group: "current" }];
  const event = (mapId: string) => ({ kind: "published", mapId });
  expect(capacityEvents(maps, [event("m"), event("o")])).toHaveLength(2);
  expect(() => capacityEvents(maps, [event("o"), event("m")])).toThrow("overtook");
  expect(() => capacityEvents(maps, [event("m")])).toThrow("never published");
  expect(() => capacityEvents(maps, [event("m"), event("o"), event("m")])).toThrow("twice");
  expect(() => capacityEvents(maps, [event("c")])).toThrow("already-current");
});
it("whole-attempt timing includes the second appearance and publication, and refuses a hidden retry", () => {
  const maps = Array.from({ length: 20 }, (_, i) => ({ id: String(i), group: "missing", pair: i % 2 === 1 }));
  const events = maps.flatMap(map => [
    { kind: "admitted", background: true, mapId: map.id, monotonicMs: 100, pid: 1 },
    ...(map.pair ? [{ kind: "admitted", background: true, mapId: map.id, monotonicMs: 180, pid: 1 }] : []),
    { kind: "published", mapId: map.id, monotonicMs: map.pair ? 300 : 200, pid: 1 },
  ]);
  expect(firstMeasurement(maps, events)).toMatchObject({ single: { count: 10, p90Ms: 100 }, pair: { count: 10, p90Ms: 200 }, all: { p90Ms: 200 } });
  expect(() => firstMeasurement(maps, [...events, events[0]])).toThrow("repeated appearance");
});
