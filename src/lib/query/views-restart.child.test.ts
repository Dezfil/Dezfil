import { describe, it, expect } from "vitest";
import { executeQuery } from "./execute";

/**
 * The child half of the restart proof: this file does real work ONLY
 * when spawned by `views.test.ts` as a second process, pointed by env
 * at a data directory whose registry the parent populated. A fresh
 * process holds no binding memory, so a non-empty registry must be
 * rebuilt before user SQL runs (the rule's restart conjunct — the
 * in-process reset tests cannot hold it, because they never leave the
 * process). It drives the PUBLIC query boundary, not the registration
 * helper: a child that registered by hand would arrange the very
 * precondition under test. In the ordinary suite it
 * records a visible skip, never a vacuous pass.
 */
const asChild = process.env.DEZFIL_RESTART_CHILD === "1";

describe.skipIf(!asChild)(
  "a restarted process over a non-empty registry",
  () => {
    it("user SQL through the public boundary answers without any prior arrangement", async () => {
      for (const name of ["alpha", "beta"]) {
        const result = await executeQuery(
          `SELECT count(*) AS n FROM "${name}"`,
        );
        expect(Number(result.preview[0]?.n)).toBe(2);
      }
    });
  },
);
