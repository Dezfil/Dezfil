import { authenticatedRoute } from "@/lib/assistant/testing/account";
import { POST as reserveRunHandler } from "@/app/api/assistant/runs/route";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";

const reserveRun = authenticatedRoute(reserveRunHandler);

/**
 * The record's named promotion: a loop failure driven through the real
 * NDJSON boundary. The provider throws a raw, path-carrying error
 * mid-exchange; the streamed response must carry the documented
 * `internal` event — exactly the catalogue sentence — and the raw detail
 * must appear NOWHERE on the wire (the detail belongs to the server
 * log).
 */

const RAW_DETAIL = "ENOENT: no such file, open '/srv/dezfil/data/secret.key'";

vi.mock("@/lib/assistant/factory", () => ({
  createProvider: () => ({
    id: "stub-throwing",
    model: "stub-throwing",
    exchange: () => ({
      send: async () => {
        throw new Error(RAW_DETAIL);
      },
      continueWith: async () => {
        throw new Error(RAW_DETAIL);
      },
    }),
  }),
}));

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  // The availability gate needs a configured key; the mocked factory
  // never contacts anything.
  process.env.ANTHROPIC_API_KEY = "test-key-never-used";
  closeMetadataDb();
  vi.stubGlobal("fetch", async () => Response.json({ tables: [], total: 0, nextAfter: null }));
});

afterEach(async () => {
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.ANTHROPIC_API_KEY;
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the assistant NDJSON boundary under a loop failure", () => {
  it("streams the documented internal event and leaks nothing", { timeout: 30_000 }, async () => {
    // The raw detail is expected on the SERVER log — silence the console
    // error while asserting it fired with the detail.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST: handler } = await import("@/app/api/assistant/messages/route");
    const response = await authenticatedRoute(handler)(
      new Request("http://dezfil.test/api/assistant/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello", runId: (await (await reserveRun()).json()).id }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.text();

    const events = body
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; code?: string; message?: string });
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.code).toBe("internal");
    expect(errorEvent?.message).toBe(ERROR_CATALOGUE.internal);

    // Nothing of the raw failure crosses the wire — not the path, not
    // the errno, not the key file.
    expect(body).not.toContain("secret.key");
    expect(body).not.toContain("ENOENT");
    expect(body).not.toContain("/srv/dezfil");

    // The detail went to the server log, as documented.
    expect(
      logged.mock.calls.some((args) =>
        args.some((a) => a instanceof Error && a.message.includes("secret.key")),
      ),
    ).toBe(true);
  });
});
