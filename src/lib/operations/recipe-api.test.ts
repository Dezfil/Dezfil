import { describe, expect, it } from "vitest";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { jsonBody, optionalJsonBody } from "./recipe-api";

const EXPECTED_BODY_MAX_BYTES = 16 * 1024 * 1024;

type BodyReader = (request: Request) => Promise<Record<string, unknown>>;

function objectWithByteLength(bytes: number): string {
  const empty = JSON.stringify({ padding: "" });
  const body = JSON.stringify({ padding: "x".repeat(bytes - Buffer.byteLength(empty)) });
  expect(Buffer.byteLength(body)).toBe(bytes);
  return body;
}

async function expectTooLarge(read: Promise<Record<string, unknown>>) {
  let caught: unknown;
  try {
    await read;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiError);
  const response = errorResponse(caught);
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    error: {
      code: "request_body_too_large",
      message: `The workflow request body exceeds the ${EXPECTED_BODY_MAX_BYTES}-byte limit.`,
    },
  });
}

function streamedBody(bytesBeforeCrossing: number) {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(new Uint8Array(bytesBeforeCrossing).fill(0x20));
      } else if (pulls === 2) {
        controller.enqueue(Uint8Array.of(0x20));
      } else {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://test/api/recipes", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  return {
    request,
    observation: () => ({ pulls, cancelled }),
  };
}

describe.each<[string, BodyReader]>([
  ["required JSON bodies", jsonBody],
  ["optional JSON bodies", optionalJsonBody],
])("the workflow API byte ceiling for %s", (_label, read) => {
  it("refuses a declared Content-Length one byte over before parsing", async () => {
    const request = new Request("http://test/api/recipes", {
      method: "POST",
      headers: { "Content-Length": String(EXPECTED_BODY_MAX_BYTES + 1) },
      body: "not JSON",
    });
    await expectTooLarge(read(request));
  });

  it("stops a streamed body when it crosses the ceiling, before parsing or reading on", async () => {
    const { request, observation } = streamedBody(EXPECTED_BODY_MAX_BYTES);
    await expectTooLarge(read(request));
    expect(observation()).toEqual({ pulls: 2, cancelled: true });
  });
});

describe("the workflow API byte ceiling's exact boundary", () => {
  it("accepts valid JSON one byte under and exactly at the ceiling", async () => {
    for (const bytes of [EXPECTED_BODY_MAX_BYTES - 1, EXPECTED_BODY_MAX_BYTES]) {
      const body = objectWithByteLength(bytes);
      const parsed = await jsonBody(
        new Request("http://test/api/recipes", { method: "POST", body }),
      );
      expect((parsed.padding as string).length).toBeGreaterThan(0);
    }
  });

  it("refuses one byte over the exact ceiling", async () => {
    const body = objectWithByteLength(EXPECTED_BODY_MAX_BYTES + 1);
    await expectTooLarge(
      jsonBody(new Request("http://test/api/recipes", { method: "POST", body })),
    );
  });
});
