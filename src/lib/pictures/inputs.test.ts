import { afterAll, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { erasureLedger } from "../../../test-support/account-erasure-ledger";
import { mintPictureCredential, revokePictureCredential } from "./credential";
import { pictureWorkScope } from "@/lib/auth/scope";
import { readAttemptInputs, recordPictureInputs } from "./inputs";
const f = erasureLedger();
vi.spyOn(metadata, "metadataDb").mockReturnValue(f.db);
afterAll(() => { vi.restoreAllMocks(); f.dispose(); });
const mapId = "target-in-target";
it("records exact artifact identities and whole-catalogue evidence across requests", () => {
  const credential = mintPictureCredential(mapId, Date.now() + 60000, f.db);
  const { scope } = pictureWorkScope(credential, f.db);
  const inputs = { catalogue: true, datasets: [{ id: "dataset-target", file: "tables/target.parquet" }, { id: "dataset-target-near", file: "tables/target-near.parquet" }] };
  recordPictureInputs(scope, `layer-${mapId}`, inputs);
  expect(readAttemptInputs(credential, [`layer-${mapId}`])).toEqual(inputs);
  expect(() => readAttemptInputs(credential, ["unread-layer"])).toThrow();
  revokePictureCredential(credential, f.db);
});
it("rejects a replacement during the render instead of relabeling old pixels", () => {
  const credential = mintPictureCredential(mapId, Date.now() + 60000, f.db);
  const { scope } = pictureWorkScope(credential, f.db);
  recordPictureInputs(scope, `layer-${mapId}`, { catalogue: false, datasets: [{ id: "dataset-target", file: "tables/target.parquet" }] });
  f.db.prepare("UPDATE data_tables SET file = 'tables/replaced.parquet' WHERE id = 'dataset-target'").run();
  expect(() => readAttemptInputs(credential, [`layer-${mapId}`])).toThrow();
  recordPictureInputs(scope, `layer-${mapId}`, { catalogue: false, datasets: [{ id: "dataset-target", file: "tables/replaced.parquet" }] });
  expect(() => readAttemptInputs(credential, [`layer-${mapId}`])).toThrow();
});
it("refuses an unattributed archive and a late request cannot contaminate a new attempt", () => {
  const old = mintPictureCredential(mapId, Date.now() + 60000, f.db);
  const { scope } = pictureWorkScope(old, f.db);
  const fresh = mintPictureCredential(mapId, Date.now() + 60000, f.db);
  recordPictureInputs(scope, `layer-${mapId}`, null);
  expect(readAttemptInputs(fresh, [])).toEqual({ catalogue: false, datasets: [] });
  recordPictureInputs(pictureWorkScope(fresh, f.db).scope, `layer-${mapId}`, null);
  expect(() => readAttemptInputs(fresh, [])).toThrow();
});
