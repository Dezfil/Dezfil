import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { externalFixture } from "../../../../test-support/external-sign-in";

let f: ReturnType<typeof externalFixture>;
beforeEach(() => { f = externalFixture(); }); afterEach(() => f.close());
interface Ready { ready: boolean; pid: number; ticketHash: string }
interface Result { status: number; checked: boolean; sessionIssued: boolean; body: { error?: { code: string } } }
function contender(presentation: ReturnType<typeof f.ticket>) {
  const child = spawn(process.execPath, ["--experimental-transform-types", path.resolve("test-support/external-sign-in-worker.mjs")],
    { stdio: ["pipe", "pipe", "pipe", "ipc"], timeout: 15000 });
  const ready = Promise.withResolvers<Ready>(), result = Promise.withResolvers<Result>();
  let output = "", errors = "";
  child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.on("data", chunk => { errors += chunk; });
  child.once("message", message => ready.resolve(message as Ready));
  const fail = (error: Error) => { ready.reject(error); result.reject(error); };
  child.once("error", fail);
  child.once("close", code => {
    if (code !== 0) fail(new Error(`Arrival worker exited ${code}: ${errors}`));
    else { try { result.resolve(JSON.parse(output)); } catch (error) { fail(error as Error); } }
  });
  // Attach a rejection observer while the caller waits for all workers to be ready.
  void result.promise.catch(() => {});
  const startKey = (Reflect.get(process, Symbol.for("dezfil.external-sign-in-start-key")) as Buffer).toString("hex");
  child.stdin!.end(JSON.stringify({ key: f.signingKey, id: presentation.claims.jti, presentation, startKey, barrier: true }));
  return { ready: ready.promise, result: result.promise, release: () => child.send("release"), stop: () => child.kill() };
}

it("concurrent processes presenting the same ticket create exactly one session and accepted id", async () => {
  const ticket = f.ticket();
  // Negative control: losing each accepted id must break the same winner assertion.
  if (process.env.DEZFIL_TEST_LOSE_TICKET_IDS === "1") f.db.exec(
    "CREATE TRIGGER lose_ticket_id AFTER INSERT ON auth_ticket_ids BEGIN DELETE FROM auth_ticket_ids WHERE id = NEW.id; END",
  );
  const workers = Array.from({ length: 3 }, () => contender(ticket));
  try {
    const ready = await Promise.all(workers.map(worker => worker.ready));
    expect(new Set(ready.map(worker => worker.pid)).size).toBe(3);
    expect(ready).toEqual(Array.from({ length: 3 }, () => ({ ready: true, pid: expect.any(Number),
      ticketHash: createHash("sha256").update(ticket.encoded).digest("hex") })));
    expect(f.db.prepare("SELECT * FROM auth_sessions").all()).toHaveLength(0);
    expect(f.db.prepare("SELECT * FROM auth_ticket_ids").all()).toHaveLength(0);
    workers.forEach(worker => worker.release());
    const results = await Promise.all(workers.map(worker => worker.result));
    expect(results.every(result => result.checked)).toBe(true);
    expect({ statuses: results.map(result => result.status).sort(),
      sessions: f.db.prepare("SELECT count(*) AS n FROM auth_sessions").get(),
      ids: f.db.prepare("SELECT id FROM auth_ticket_ids").all(),
    }).toEqual({ statuses: [200, 401, 401], sessions: { n: 1 }, ids: [{ id: ticket.claims.jti }] });
    expect(results.filter(result => result.sessionIssued)).toHaveLength(1);
    for (const loser of results.filter(result => result.status !== 200)) {
      expect(loser.body.error?.code).toBe("invalid_ticket"); expect(loser.sessionIssued).toBe(false);
    }
  } finally {
    workers.forEach(worker => worker.stop());
    await Promise.allSettled(workers.map(worker => worker.result));
  }
});
