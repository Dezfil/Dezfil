import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { hashPassword } from "./passwords";
import { measureDerivationTiming } from "../../../scripts/derivation-probe-support.mjs";
it("records the unchanged native derivation singly and with two active", async () => {
  const timing = await measureDerivationTiming(() => hashPassword("measured local field notebook"));
  expect(timing.singleMs).toBeGreaterThan(0); expect(timing.pairedMs).toHaveLength(2);
  writeFileSync(path.join(process.env.DEZFIL_DATA_DIR!, "derivation-timing.json"), JSON.stringify(timing));
  console.log(JSON.stringify({ label: "confirmed mechanism, unmeasured impact", scope: "local native derivation timing; not served latency", ...timing }));
});
