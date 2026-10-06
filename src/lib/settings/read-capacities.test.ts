import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readInstanceSettings } from "./read";
import { activateSettingsStore, writeStoredSettings } from "./store";
import { testAccountScope } from "@/lib/test-support/accounts";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { getTableByName, updateTableData } from "@/lib/metadata/tables";
import { compileOperation } from "@/lib/operations/compile";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(async () => {
  f = instanceSettingsFixture(); activateSettingsStore(f.db);
  for (const [name, csv] of [["addresses", "address\nOne street\n"], ["origins", "name,lon,lat\na,13,52\n"]]) {
    const file = path.join(f.dir, `${name}.csv`); writeFileSync(file, csv);
    await ingestFile(testAccountScope(f.db, "admin"), file, `${name}.csv`);
  }
});
afterEach(() => { resetQueryInstance(); f.close(); });
function claimRows(name: string, rowCount: number) {
  const table = getTableByName(name, f.db)!;
  updateTableData({ name, id: table.id }, { file: table.file, geometryColumn: table.geometryColumn,
    geometryType: table.geometryType, crsAssumed: table.crsAssumed, headerSuspect: false, rowCount,
    importedAt: table.importedAt! }, f.db);
}
it.each([[600, 27, 13], [660, 30, 15], [80, 1, 0]])(
  "reports and enforces capacities at query 60 and run %i", async (run, geocodeRows, isochroneOrigins) => {
    writeStoredSettings({ queryTimeoutS: 60, operationTimeoutS: run }, f.db);
    const result = readInstanceSettings(f.context, f.db);
    expect(result.capacities).toEqual({ geocodeRows, isochroneOrigins });
    // Capacity promises a budget, never an available provider.
    expect(result.settings.geocoderUrl.value).toEqual({ set: false });
    process.env.DEZFIL_GEOCODER_URL = "https://geocode.example";
    process.env.DEZFIL_ISOCHRONE_URL = "https://routing.example";
    const scope = testAccountScope(f.db, "admin");
    const cases = [
      { table: "addresses", operation: "geocode_addresses", bound: geocodeRows, params: { column: "address" } },
      { table: "origins", operation: "isochrone", bound: isochroneOrigins, params: { travel_mode: "driving", bands: [5] } },
    ];
    for (const item of cases) {
      claimRows(item.table, item.bound + 1);
      await expect(compileOperation(scope, item.operation, { input: item.table, name: "result", ...item.params })).rejects.toMatchObject({
        code: "invalid_request", message: expect.stringContaining(`accepts ${item.bound}`),
      });
      if (item.bound > 0) {
        claimRows(item.table, item.bound);
        await expect(compileOperation(scope, item.operation, { input: item.table, name: "result", ...item.params })).resolves.toMatchObject({ name: "result" });
      }
    }
  },
);
