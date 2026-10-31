import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { authenticateSession, createApiToken, issueSession } from "@/lib/auth/credentials";
import { getAccount } from "@/lib/metadata/accounts";
import { testAccountScope } from "@/lib/test-support/accounts";
import { saveAssistantKey } from "./keys/store";
import { assistantRuns } from "./runs";
import { pendingActions } from "./pending";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";
import { outputText, responseWire } from "./testing/wire";

/**
 * One account cannot take the assistant from the others, against the real run
 * store through the real routes: a person who reserves and never submits, and a
 * person who keeps turns open, each leave room for someone with a working key.
 * Provider requests wait until the test lets them finish, so a turn stays open
 * for as long as a case needs it.
 */

const origin = "http://127.0.0.1:3216";
let dir: string;
let waiting: (() => void)[] = [];
let answered = 0;

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-run-capacity-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  vi.stubEnv("PORT", "3216");
  closeMetadataDb(); resetQueryInstance(); assistantRuns.resetForTests(); pendingActions.resetForTests();
  waiting = []; answered = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (new URL(request.url).origin === origin) return dispatchAssistantTestRoute(request);
    await new Promise<void>((resolve) => { waiting.push(resolve); });
    answered++;
    return responseWire([outputText("Done.")]);
  });
});
afterEach(async () => { release(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

function release() { for (const resolve of waiting.splice(0)) resolve(); }
function person(id: string, key = true) {
  const db = metadataDb();
  testAccountScope(db, id);
  if (key) saveAssistantKey(id, "openai", `sk-${id}-own-key-000000000000`, db);
  const context = authenticateSession(issueSession(getAccount(id, db)!, db, Date.now()).secret, db)!;
  const token = createApiToken(context, "Route fixture", db).secret;
  const call = (url: string, init: RequestInit = {}) => dispatchAssistantTestRoute(new Request(`${origin}${url}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }));
  return {
    reserve: () => call("/api/assistant/runs", { method: "POST" }),
    submit: (runId: string) => call("/api/assistant/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, message: "Work.", history: [] }) }),
    read: (runId: string) => call(`/api/assistant/runs/${runId}`),
    async reserved() { const response = await this.reserve(); expect(response.status).toBe(201); return (await response.json() as { id: string }).id; },
  };
}
const refusal = async (response: Response) => { expect(response.ok).toBe(false); return { status: response.status, ...(await response.json() as { error: { code: string; message: string } }).error }; };
const until = (done: () => boolean) => vi.waitFor(() => { if (!done()) throw new Error("not yet"); });

it("holds the compound case: the third reservation refused, another person running meanwhile, four open turns, the fifth refused while another's is admitted", async () => {
  const hog = person("hog"), other = person("other"), keyless = person("keyless", false);

  // Reserving and never submitting takes nothing from anyone.
  const [first, second] = [await hog.reserved(), await hog.reserved()];
  const third = await refusal(await hog.reserve());
  expect(third).toMatchObject({ status: 409, code: "assistant_reservation_limit" });
  expect(third.message).toMatch(/DELETE \/api\/assistant\/runs/);

  const running = await other.submit(await other.reserved());
  expect(running.status).toBe(200);
  await until(() => waiting.length === 1);
  release();
  expect(await running.text()).toContain("Done.");

  // Without a usable key there is no reservation at all.
  expect(await refusal(await keyless.reserve())).toMatchObject({ status: 404, code: "assistant_disabled", message: "Add your own API key to use the assistant." });

  // Four open turns are one account's whole share.
  const streams = [await hog.submit(first), await hog.submit(second)];
  for (let i = 0; i < 2; i++) streams.push(await hog.submit(await hog.reserved()));
  for (const stream of streams) expect(stream.status).toBe(200);
  await until(() => waiting.length === 4);
  const fifth = await hog.reserved();
  const refused = await refusal(await hog.submit(fifth));
  expect(refused).toMatchObject({ status: 409, code: "assistant_capacity" });
  expect(refused.message).toMatch(/four/i);
  expect((await (await hog.read(fifth)).json() as { state: string }).state).toBe("reserved");

  const admitted = await other.submit(await other.reserved());
  expect(admitted.status).toBe(200);
  await until(() => waiting.length === 5);

  release();
  for (const stream of [...streams, admitted]) await stream.text();
  expect(answered).toBe(6);
  // A share comes back when a turn ends: the same reservation now goes through.
  const retried = await hog.submit(fifth);
  expect(retried.status).toBe(200);
  await until(() => waiting.length === 1);
  release();
  await retried.text();
});

it("keeps the eight places for submissions, and a reservation refused at submission stays for a retry", async () => {
  const [ada, bea, cal] = [person("ada"), person("bea"), person("cal")];
  const open: Response[] = [];
  for (const who of [ada, bea]) for (let i = 0; i < 4; i++) open.push(await who.submit(await who.reserved()));
  for (const stream of open) expect(stream.status).toBe(200);
  await until(() => waiting.length === 8);

  // Every place busy: reserving still works and holds nothing.
  const waitingRun = await cal.reserved();
  const refused = await refusal(await cal.submit(waitingRun));
  expect(refused).toMatchObject({ status: 409, code: "assistant_capacity" });
  expect(refused.message).not.toMatch(/four/i);
  expect((await (await cal.read(waitingRun)).json() as { state: string }).state).toBe("reserved");

  release();
  for (const stream of open) await stream.text();
  const retried = await cal.submit(waitingRun);
  expect(retried.status).toBe(200);
  await until(() => waiting.length === 1);
  release();
  await retried.text();
});

it("frees a reservation's place in the two when it is released", async () => {
  const ada = person("ada");
  const first = await ada.reserved(); await ada.reserved();
  expect((await refusal(await ada.reserve())).code).toBe("assistant_reservation_limit");
  const released = await dispatchReleaseFor("ada", first);
  expect(released.status).toBe(200);
  expect((await ada.reserve()).status).toBe(201);
});

async function dispatchReleaseFor(id: string, runId: string) {
  const db = metadataDb();
  const context = authenticateSession(issueSession(getAccount(id, db)!, db, Date.now()).secret, db)!;
  const token = createApiToken(context, "Release fixture", db).secret;
  return dispatchAssistantTestRoute(new Request(`${origin}/api/assistant/runs/${runId}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }));
}
