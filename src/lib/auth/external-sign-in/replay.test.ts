import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { externalFixture } from "../../../../test-support/external-sign-in";
let f: ReturnType<typeof externalFixture>;
beforeEach(() => { f = externalFixture(); }); afterEach(() => f.close());
async function present() {
  return await new Promise<{ status: number; sessions: number; checked: boolean; body: { error?: { code: string } } }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-transform-types", path.resolve("test-support/external-sign-in-worker.mjs")],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });
    let out = "", errors = "";
    child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
    child.on("error", reject); child.on("close", code => {
      if (code !== 0) reject(new Error(`Arrival worker exited ${code}: ${errors}`));
      else { try { resolve(JSON.parse(out)); } catch (error) { reject(error); } }
    });
    child.stdin.end(JSON.stringify({ key: f.signingKey, id: "same-accepted-id" }));
  });
}
it("refuses an accepted id after process replacement on a fresh valid start without a session cookie", async () => {
  expect(await present()).toMatchObject({ status: 200, sessions: 1, checked: true });
  // Deliberate negative control: run this case with the variable set to 1.
  // The very same refusal assertion must fail if durable ids are lost.
  if (process.env.DEZFIL_TEST_LOSE_TICKET_IDS === "1") f.db.exec("DELETE FROM auth_ticket_ids");
  const replay = await present();
  expect(replay.checked).toBe(true); expect(replay.status).toBe(401);
  expect(replay.body.error?.code).toBe("invalid_ticket"); expect(replay.sessions).toBe(1);
});
