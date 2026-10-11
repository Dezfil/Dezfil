import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The templates browser journey's own teardown, driven without a browser:
 * the spec's hooks are collected through a stand-in for the browser test
 * runner and called with a request stand-in that records every call it is
 * asked to make and reaches no server. Setup refuses an instance that is
 * off loopback or on port 3000 (the default address included), and the
 * runner still runs teardown after a refused setup, so teardown must then
 * write nothing to that instance. The control is a setup that passes: the
 * fixture templates are built in the spec's own scratch folder and served
 * by its loopback catalogue, and teardown removes the downloads and unsets
 * the catalogue's settings it wrote.
 */

type Hook = (fixtures: { request: unknown }) => Promise<void>;
const hooks = vi.hoisted(() => ({ beforeAll: [] as Hook[], afterAll: [] as Hook[] }));

vi.mock("@playwright/test", async () => {
  const { expect: check } = await import("vitest");
  const test = Object.assign(() => undefined, {
    beforeAll: (hook: Hook) => { hooks.beforeAll.push(hook); },
    afterAll: (hook: Hook) => { hooks.afterAll.push(hook); },
    beforeEach: () => undefined,
    skip: () => undefined,
    describe: Object.assign((_: string, body: () => void) => body(), { configure: () => undefined }),
  });
  return { test, expect: check };
});

/** Load the journey afresh, so its hooks and their state are this case's. */
async function loadJourney(): Promise<{ setup: Hook; teardown: Hook }> {
  await import("../../../e2e/templates.spec");
  expect([hooks.beforeAll.length, hooks.afterAll.length]).toEqual([1, 1]);
  return { setup: hooks.beforeAll[0], teardown: hooks.afterAll[0] };
}

/** A request stand-in: answers every call 200 and records it; the
 * settings read says nothing names the catalogue. */
function recorder() {
  const calls: string[] = [];
  const request = new Proxy({}, {
    get: (_, method) => async (url: string) => {
      calls.push(`${String(method).toUpperCase()} ${url}`);
      return { status: () => 200, json: async () => ({ settings: {} }) };
    },
  });
  return { calls, request };
}

let baseUrl: string | undefined;
beforeEach(() => { baseUrl = process.env.DEZFIL_BASE_URL; });
afterEach(() => {
  if (baseUrl === undefined) delete process.env.DEZFIL_BASE_URL;
  else process.env.DEZFIL_BASE_URL = baseUrl;
  hooks.beforeAll.length = 0;
  hooks.afterAll.length = 0;
  vi.resetModules();
});

describe("the templates journey's teardown", () => {
  it("writes nothing to the default address, which its setup refused", async () => {
    delete process.env.DEZFIL_BASE_URL;
    const { setup, teardown } = await loadJourney();
    const { calls, request } = recorder();
    await expect(setup({ request })).rejects.toThrow(/isolated loopback/);
    await teardown({ request });
    expect(calls).toEqual([]);
  });

  it("writes nothing to an instance off loopback, which its setup refused", async () => {
    process.env.DEZFIL_BASE_URL = "http://192.0.2.10:3999";
    const { setup, teardown } = await loadJourney();
    const { calls, request } = recorder();
    await expect(setup({ request })).rejects.toThrow(/isolated loopback/);
    await teardown({ request });
    expect(calls).toEqual([]);
  });

  it("removes the downloads and unsets the catalogue's settings after a setup that wrote them", async () => {
    process.env.DEZFIL_BASE_URL = "http://127.0.0.1:3999";
    const { setup, teardown } = await loadJourney();
    const { calls, request } = recorder();
    await setup({ request });
    expect(calls).toEqual(["GET /api/instance/settings", "PATCH /api/instance/settings"]);
    calls.length = 0;
    await teardown({ request });
    expect(calls).toEqual(["DELETE /api/templates/downloads", "PATCH /api/instance/settings"]);
  });
});
