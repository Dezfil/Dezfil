import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appendFileSync } from "node:fs";
import { authenticateSession, issueSession, type AuthContext } from "@/lib/auth/credentials";
import { delegateCredential } from "@/lib/auth/delegation";
import { getAccount } from "@/lib/metadata/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { RENDER_CHECK_PATH } from "@/lib/export/render-check";
import { renderStats } from "@/lib/export/render-image";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { testAccountScope } from "@/lib/test-support/accounts";
import { PART_TEST_LIMITS } from "./part-test-answer";
import { testPart } from "./part-tests";

/**
 * The image renderer's Test through the real renderer: a headless Chromium
 * launched by this process photographs the render route's check picture,
 * served by a production standalone that shares this process's data
 * directory, and the Test reads the mark back from the image. Its first
 * Test after the standalone starts is the cold one, the next the warm one;
 * each passes on the mark, well inside the Test's limit.
 *
 * Provisioning, as the map check's own real-render tests: the port of a
 * production standalone sharing this process's data directory in
 * DEZFIL_MAP_LOOK_RENDER (skipped without it), DEZFIL_DATA_DIR,
 * DEZFIL_CHROMIUM_PATH at a headless Chromium, and
 * DEZFIL_RENDER_DELEGATION_KEY (64 hexadecimal digits), the render
 * credential's signing key, which the standalone takes at start with
 * `--import="data:text/javascript,process[Symbol.for('dezfil.session-delegation-key')]=Buffer.from(process.env.DEZFIL_RENDER_DELEGATION_KEY,'hex')"`.
 * The picture reaches nothing outside this machine. DEZFIL_RENDER_CHECK_TIMES
 * names a file each Test's time is added to, one line each, for the
 * measurement.
 */

keepRequestsOnThisMachine();

const port = process.env.DEZFIL_MAP_LOOK_RENDER;
const times = process.env.DEZFIL_RENDER_CHECK_TIMES;
const SIGNING_KEY = Symbol.for("dezfil.session-delegation-key");

describe.skipIf(!port)("the image renderer's Test on the real renderer", () => {
  let context: AuthContext;
  let heldKey: unknown;
  const baseUrl = `http://127.0.0.1:${port}`;

  beforeAll(async () => {
    if (!process.env.DEZFIL_DATA_DIR) throw new Error("DEZFIL_DATA_DIR must name the directory the standalone shares");
    const key = process.env.DEZFIL_RENDER_DELEGATION_KEY ?? "";
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("DEZFIL_RENDER_DELEGATION_KEY must carry the standalone's render signing key, 64 hexadecimal digits");
    const slots = process as unknown as Record<symbol, unknown>;
    heldKey = slots[SIGNING_KEY]; slots[SIGNING_KEY] = Buffer.from(key, "hex");
    vi.stubEnv("PORT", port!);
    closeMetadataDb();
    const db = metadataDb();
    testAccountScope(db, "render-check-admin");
    db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'render-check-admin'").run();
    context = authenticateSession(issueSession(getAccount("render-check-admin", db)!, db, Date.now()).secret, db)!;
    // The standalone takes this process's render credential, or every
    // Test would run into its limit at the sign-in redirect.
    const page = await fetch(`${baseUrl}${RENDER_CHECK_PATH}`, { headers: { authorization: `Bearer ${delegateCredential(context)}` }, redirect: "manual" });
    if (page.status !== 200) throw new Error(`The standalone on port ${port} refused this process's render credential (${page.status}): start it with the same DEZFIL_RENDER_DELEGATION_KEY`);
  }, 60_000);
  afterAll(() => {
    (process as unknown as Record<symbol, unknown>)[SIGNING_KEY] = heldKey;
    vi.unstubAllEnvs();
    closeMetadataDb();
  });

  it("photographs the check picture and reads the mark back, cold then warm, well inside its limit", async () => {
    for (const round of ["cold", "warm"]) {
      const launches = renderStats().launches;
      const asked = Date.now();
      const answer = await testPart(context, "image_renderer", metadataDb(), Date.now(), baseUrl);
      const elapsed = Date.now() - asked;
      console.info(JSON.stringify({ round, answer, elapsedMs: elapsed }));
      if (times) appendFileSync(times, `${round} ${answer.result === "passed" ? answer.milliseconds : answer.reason} ${elapsed}\n`);
      expect(answer).toEqual({ part: "image_renderer", result: "passed", milliseconds: expect.any(Number) });
      expect(renderStats().launches).toBe(launches + 1);
      expect(elapsed).toBeLessThan(PART_TEST_LIMITS.image_renderer * 1000 / 2);
    }
  }, 60_000);
});
