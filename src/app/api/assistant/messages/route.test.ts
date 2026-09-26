import { assistantRuns } from "@/lib/assistant/runs";
import { POST as reserveRun } from "@/app/api/assistant/runs/route";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { pendingActions, type ParkedRun } from "@/lib/assistant/pending";
import type { ToolOutcome } from "@/lib/assistant/provider";
import { CHANGE_GROUP_HEADER } from "@/lib/api/change-group";

/**
 * The exchange endpoint's confirmation protocol: the two request forms,
 * resolution bound to the server-issued pending-action id, the documented
 * stale/resolved/superseded answers, and the parked change group riding
 * the resumed execution.
 */

async function post(body: unknown): Promise<Response> {
  if (body && typeof body === "object" && "message" in body && !("resolution" in body)) {
    const reservation = await reserveRun();
    body = { ...body, runId: (await reservation.json()).id };
  }
  return POST(
    new Request("http://127.0.0.1:3000/api/assistant/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function events(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A parked run whose exchange is scripted in-place: the model, told the
 * outcome, answers with plain text and stops. */
function park(overrides: Partial<ParkedRun> = {}) {
  const seen: ToolOutcome[][] = [];
  const id = pendingActions.park({
    exchange: {
      async send() {
        throw new Error("a parked exchange is never re-sent");
      },
      async continueWith(outcomes) {
        seen.push(outcomes);
        return { text: "Understood.", toolCalls: [] };
      },
    },
    calls: [{ id: "p1", name: "delete_table", args: { name: "parks" } }],
    index: 0,
    outcomes: [],
    steps: 1,
    headers: { [CHANGE_GROUP_HEADER]: "group-one" },
    policy: "full",
    ...overrides,
  });
  return { id, seen };
}

beforeEach(() => {
  assistantRuns.resetForTests(); pendingActions.resetForTests();
  process.env.ANTHROPIC_API_KEY = "test-key";
  vi.stubGlobal("fetch", async () => Response.json({ tables: [], total: 0, nextAfter: null }));
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  vi.unstubAllGlobals();
});

describe("POST /api/assistant/messages", () => {
  it("rejects a body carrying both a message and a resolution", async () => {
    const res = await post({
      message: "hi",
      resolution: { pending: "x", approved: true },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects a malformed resolution", async () => {
    const res = await post({ resolution: { pending: 7 } });
    expect(res.status).toBe(400);
  });

  it("answers pending_unknown for an id it never issued", async () => {
    const res = await post({
      resolution: { pending: "never-issued", approved: true },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("pending_unknown");
  });

  it("a declined resolution resumes the parked run — the model hears the note", async () => {
    const { id, seen } = park();
    const res = await post({ resolution: { pending: id, approved: false } });
    expect(res.status).toBe(200);

    const lines = await events(res);
    expect(lines.map((l) => l.type)).toEqual(["tool_result", "message", "done"]);
    expect(lines[0]).toMatchObject({ ok: false, tool: "delete_table" });
    expect(JSON.parse(seen[0][0].body).note).toContain("did not confirm");
  });

  it("an approved resolution executes the parked call under the parked change group", async () => {
    const requests: { url: string; method?: string; group: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/api/catalogue/tables")) return Response.json({ tables: [], total: 0, nextAfter: null });
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(input),
          method: init?.method,
          group: headers.get(CHANGE_GROUP_HEADER),
        });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    );

    const { id } = park();
    const res = await post({ resolution: { pending: id, approved: true } });
    const lines = await events(res);

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:3000/api/tables/parks",
        method: "DELETE",
        group: "group-one",
      },
    ]);
    expect(lines.map((l) => l.type)).toEqual([
      "tool_call",
      "tool_result",
      "message",
      "done",
    ]);
  });

  it("a repeat resolution answers pending_resolved and executes nothing further", async () => {
    const { id } = park();
    const first = await post({ resolution: { pending: id, approved: false } });
    await first.text();

    const res = await post({ resolution: { pending: id, approved: true } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("pending_resolved");
  });

  it("a superseded action answers pending_superseded on later resolution", async () => {
    // The new message's provider call must not leave the process: fail fast.
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/catalogue/tables")) return Response.json({ tables: [], total: 0, nextAfter: null });
        throw new Error("offline");
      }) as typeof fetch,
    );

    const { id } = park();
    const res = await post({ message: "actually, keep it", supersedes: id });
    expect(res.status).toBe(200);
    await res.text(); // drain: the provider errors in-stream, harmlessly

    const after = await post({ resolution: { pending: id, approved: true } });
    expect(after.status).toBe(409);
    const body = (await after.json()) as { error: { code: string } };
    expect(body.error.code).toBe("pending_superseded");
  });
});
