import { expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { credentialMaintenance } from "./credential-maintenance";
import { cleanupProbe } from "../../../scripts/credential-cleanup-probe.mjs";
import { assertCleanupSnapshot, snapshotCredentials } from "../../../scripts/credential-cleanup-fixture.mjs";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import * as setup from "@/app/api/auth/setup/route";
import * as signIn from "@/app/api/auth/sign-in/route";
import * as entry from "@/app/api/auth/entry/route";
import * as session from "@/app/api/auth/session/route";
import * as redeem from "@/app/api/auth/redeem/route";
import * as tokens from "@/app/api/account/tokens/route";
import * as revoke from "@/app/api/account/tokens/[id]/route";
import * as users from "@/app/api/users/route";

it("runs all cleanup probe phases through real credential handlers and rejects seeded missing and premature cleanup", async () => {
  const db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  type State = { before: Record<string, string[]> };
  const state = {} as State;
  let sweep: ReturnType<typeof credentialMaintenance> | undefined;
  const routes: Record<string, Record<string, (request: Request) => Promise<Response>>> = {
    "/api/auth/entry": entry, "/api/auth/setup": setup, "/api/auth/sign-in": signIn,
    "/api/auth/session": session, "/api/auth/redeem": redeem, "/api/account/tokens": tokens, "/api/users": users,
  };
  const transport: typeof fetch = async (input, init) => {
    // A process restart creates a fresh coordinator; no socket/server timing is claimed here.
    sweep?.(db);
    const request = socketRequest(new Request(String(input), init));
    const pathname = new URL(String(input)).pathname;
    if (pathname.startsWith("/api/account/tokens/")) return revoke.DELETE(request, { params: Promise.resolve({ id: pathname.split("/").at(-1)! }) });
    return routes[pathname][request.method](request);
  };
  try {
    expect((await cleanupProbe("prepare", "http://instance.test", db, state, transport)).label).toBe("confirmed");
    const seeded = snapshotCredentials(db);
    expect(() => assertCleanupSnapshot(seeded, seeded, "boot")).toThrow(/bounded cleanup/);
    const premature = structuredClone(seeded); premature.tokens = premature.tokens.filter((id: string) => id !== "cleanup-recent-token");
    // Drain mode checks preserved history independently of boot work.
    expect(() => assertCleanupSnapshot(seeded, premature, "drain")).toThrow();
    sweep = credentialMaintenance(); sweep(db);
    expect((await cleanupProbe("sweep", "http://instance.test", db, state, transport)).drainedOld).toEqual({ sessions: 0, links: 0, tokens: 0 });
    sweep = credentialMaintenance(); sweep(db);
    expect((await cleanupProbe("restart", "http://instance.test", db, state, transport)).label).toBe("confirmed");
  } finally { vi.restoreAllMocks(); db.close(); }
});

it("rejects premature history removal independently even after all expired rows drain", () => {
  const before = { sessions: ["cleanup-old-0", "live"], links: ["cleanup-old-0", "margin"], tokens: ["cleanup-old-0", "recent"] };
  const after = { sessions: ["live"], links: ["margin"], tokens: ["recent"] };
  expect(() => assertCleanupSnapshot(before, after, "drain")).not.toThrow();
  for (const kind of ["sessions", "links", "tokens"] as const) {
    const premature = structuredClone(after); premature[kind] = [];
    expect(() => assertCleanupSnapshot(before, premature, "drain")).toThrow(/retained/);
  }
});
