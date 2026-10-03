import { expect, it } from "vitest";
import { assertPublishedStatus, assertPublicationState } from "../../../scripts/publication-probe-support.mjs";
const refusal = { status: 429, headers: { "cache-control": "private, no-store" }, json: { error: { code: "rate_limited", message: "Too many requests. Please slow down." } } };
it("rejects a seeded shared direct key and a provenance bypass in the wire assertions", () => {
  expect(() => assertPublishedStatus(refusal, 404)).toThrow();
  expect(() => assertPublishedStatus({ status: 404, headers: {}, json: {} }, 503)).toThrow();
  expect(() => assertPublishedStatus(refusal, 429)).not.toThrow();
  expect(() => assertPublishedStatus({ status: 503, headers: { "cache-control": "private, no-store" }, json: { error: { code: "ingress_unavailable", message: "The instance cannot serve published maps yet." } } }, 503)).not.toThrow();
});
it("rejects unbounded state, missing observation and wrong wire copy independently", () => {
  expect(() => assertPublicationState([{ phase: "publication", size: 10_001 }], 1)).toThrow();
  expect(() => assertPublicationState([], 1)).toThrow();
  expect(() => assertPublishedStatus({ ...refusal, headers: {} }, 429)).toThrow();
  expect(() => assertPublishedStatus({ ...refusal, json: { error: { code: "rate_limited", message: "Different" } } }, 429)).toThrow();
  expect(assertPublicationState([{ phase: "publication", size: 10_000 }], 1)).toBe(10_000);
});
