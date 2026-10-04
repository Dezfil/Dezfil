import { afterEach, beforeEach, expect, it } from "vitest";
import { erasureLedger, contentTables, type ErasureLedger } from "../../../test-support/account-erasure-ledger";
import { proveErasure } from "../../../test-support/account-erasure-proof";
import { eraseAccountContent } from "@/lib/metadata/account-erasure-content";
let f: ErasureLedger;
beforeEach(() => { f = erasureLedger(); });
afterEach(() => f.dispose());
it.each(["active", "deactivated"])("refuses %s content erasure with every row and file unchanged", state => {
  f.db.prepare("UPDATE accounts SET status = ? WHERE id = 'target'").run(state);
  const before = f.snapshot(), files = f.files();
  expect(() => eraseAccountContent("target", f.db)).toThrow("deleting");
  expect(f.snapshot()).toEqual(before); expect(f.files()).toEqual(files);
});
it("erases every populated owned parent and child against the independent ledger, preserving all other rows and files", async () => {
  f.db.exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  const before = f.snapshot(), files = f.files();
  const result = await proveErasure(f.inventoryFor(contentTables), f.probesFor(contentTables, f.content), () => { eraseAccountContent("target", f.db); });
  expect(result).toHaveLength(contentTables.length);
  expect(f.snapshot()).toEqual(f.expected(before, [f.content]));
  expect(f.files()).toEqual(files);
  expect(f.db.pragma("foreign_key_check")).toEqual([]);
  eraseAccountContent("target", f.db);
  expect(f.snapshot()).toEqual(f.expected(before, [f.content]));
});
it("captures generation paths and owned map/layer identities before cascades remove them", () => {
  f.db.exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  const captured = eraseAccountContent("target", f.db);
  expect(captured.datasets).toEqual([expect.objectContaining({ id: "dataset-target", file: "tables/target.parquet" })]);
  expect(captured.maps).toEqual(["target-in-target", "target-in-target-near"]);
});
it("rolls back the complete stage when a child or parent refuses deletion", () => {
  f.db.exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'; CREATE TRIGGER fail_content BEFORE DELETE ON recipes BEGIN SELECT RAISE(ABORT, 'content failure'); END");
  const before = f.snapshot();
  expect(() => eraseAccountContent("target", f.db)).toThrow("content failure");
  expect(f.snapshot()).toEqual(before);
});
