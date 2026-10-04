import { expect, it } from "vitest";
import { boundedMcpRequest } from "./bounded-handoff";
import { smallJsonValue } from "./json-body";
import { parsePublishBody } from "@/lib/publish/publish-body";
import { gateHead } from "@/lib/auth/route-gate";

// Framework requests need not share the platform constructor's private state.
function foreignRequest(method: string, text?: string, signal = new AbortController().signal): Request {
  return {
    url: "http://instance.test/api/mcp", method,
    headers: new Headers({ "content-type": "application/json", "x-control": "retained" }),
    body: text === undefined ? null : new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(text)); controller.close();
    } }), signal,
  } as Request;
}

it("rebuilds the admitted SDK request from parts of a foreign request", async () => {
  const abort = new AbortController();
  const incoming = foreignRequest("POST", '{"value":"雪"}', abort.signal);
  const admitted = await boundedMcpRequest(incoming);
  expect(admitted).toBeInstanceOf(Request);
  expect(admitted.url).toBe(incoming.url);
  expect(admitted.method).toBe("POST");
  expect(admitted.headers.get("x-control")).toBe("retained");
  expect(await admitted.text()).toBe('{"value":"雪"}');
  abort.abort(); expect(admitted.signal.aborted).toBe(true);
});

it.each(["GET", "HEAD"])("preserves a foreign bodyless %s request", async method => {
  const admitted = await boundedMcpRequest(foreignRequest(method));
  expect(admitted.method).toBe(method); expect(admitted.body).toBeNull();
});

it("reads bounded JSON and publication bodies without platform request branding", async () => {
  expect(await smallJsonValue(foreignRequest("POST", '{"value":1}'))).toEqual({ value: 1 });
  expect(await parsePublishBody(foreignRequest("POST", '{"theme":"dark"}'))).toEqual({ theme: "dark", viewerControls: undefined });
});

it("passes the foreign HEAD request through the upload wrapper without reconstruction", async () => {
  const incoming = foreignRequest("HEAD");
  const response = await gateHead(incoming, async request => {
    expect(request).toBe(incoming);
    return new Response("body", { status: 200, headers: { "x-control": "retained" } });
  });
  expect(response.status).toBe(200); expect(response.headers.get("x-control")).toBe("retained");
  expect(await response.text()).toBe("");
});
