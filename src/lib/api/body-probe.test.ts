import { expect, it } from "vitest";
import { assertByteRefusal, assertValidation, assertNoBodyMutation, sizedJson } from "../../../scripts/body-probe-support.mjs";
import { LARGE_JSON_BODY_MAX_BYTES } from "./request-bounds";
import { largeJsonValue } from "./json-body";
it("rejects a lowered framework-copy limit, swallowed refusal and unbounded MCP response independently", async () => {
  const complete = sizedJson({ name: 0 }, LARGE_JSON_BODY_MAX_BYTES + 1, "utf8");
  const truncated = complete.subarray(0, 10 * 1024 * 1024);
  let result;
  try { await largeJsonValue(new Request("http://instance.test", { method: "POST", body: truncated })); result = { status: 201, json: {} }; }
  catch { result = { status: 400, json: { error: { code: "invalid_request", message: "Expected a JSON body." } } }; }
  expect(() => assertByteRefusal(result, LARGE_JSON_BODY_MAX_BYTES)).toThrow();
  expect(() => assertByteRefusal({ status: 201, json: { name: "Untitled map" } }, LARGE_JSON_BODY_MAX_BYTES)).toThrow();
  expect(() => assertByteRefusal({ status: 200, json: { jsonrpc: "2.0", id: 1, result: {} } }, LARGE_JSON_BODY_MAX_BYTES)).toThrow();
});
it("requires exact refusal envelopes, semantic validation, and unchanged state", () => {
  const refused = { status: 413, json: { error: { code: "request_body_too_large", message: "The request body exceeds the 65536-byte limit." } } };
  expect(() => assertByteRefusal(refused, 65_536)).not.toThrow();
  expect(() => assertByteRefusal({ ...refused, json: { error: "too large" } }, 65_536)).toThrow();
  const expected = { status: 400, json: { error: { code: "invalid_request", message: "name must be a string." } } };
  expect(() => assertValidation(expected, expected)).not.toThrow();
  expect(() => assertValidation({ status: 400, json: { error: { code: "invalid_request", message: "Expected JSON." } } }, expected)).toThrow();
  expect(() => assertNoBodyMutation([], [{ id: "unexpected" }])).toThrow();
});
it.each(["utf8", "escaped"])("places complete %s JSON at each tier boundary", encoding => {
  for (const limit of [65_536, 131_072, 16_777_216]) for (const delta of [-1, 0, 1]) {
    const bytes = sizedJson({ message: "雪" }, limit + delta, encoding);
    expect(bytes.length).toBe(limit + delta); expect(JSON.parse(bytes.toString()).message).toBe("雪");
    expect(() => JSON.parse(bytes.subarray(0, bytes.length - 1).toString())).toThrow();
  }
});
