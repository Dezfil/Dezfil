import { privateTileAccess } from "@/lib/tiles/access";
import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import path from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { getTileRecord } from "@/lib/metadata/tiles";
import { boundedEvaluation } from "@/lib/query/bounded";
import { ensureTiles, resetTileBuilds, tileBuildsSettled, tileFingerprint } from "@/lib/tiles/build";
import { tileArchivePath } from "@/lib/tiles/paths";
import { clearGeometry, setGeometry } from "./service";
import { geometryRevision } from "./read";
import { cleanupGeometryTest, setupGeometryTest, stored } from "@/lib/test-support/geometry";
let dir: string;
let release: (() => Promise<void>) | undefined;
beforeEach(async () => { dir = await setupGeometryTest(); resetTileBuilds(); });
afterEach(async () => { await release?.(); await tileBuildsSettled(); resetTileBuilds(); delete process.env.DEZFIL_TIPPECANOE; delete process.env.DEZFIL_GEOMETRY_TILER_STARTED; delete process.env.DEZFIL_GEOMETRY_TILER_RELEASE; await cleanupGeometryTest(dir); });
it("actual running tiles cannot publish after a geometry change; unrelated tiles and next SQL stay correct", async () => {
  const t=await stored("SELECT * FROM (VALUES ('POINT (10 20)',30,40), ('POINT (11 21)',31,41)) t(payload,x,y)",{name:"points"});
  const other=await stored("SELECT * FROM (VALUES ('POINT (50 60)'), ('POINT (51 61)')) t(payload)",{name:"points_extra"});
  const first=await setGeometry(testAccountScope(), t.name,geometryRevision(t),{format:"wkt",columns:["payload"]});
  await setGeometry(testAccountScope(), other.name,geometryRevision(other),{format:"wkt",columns:["payload"]});
  const map=createMap(testAccountScope(), "Tiles"), sql="SELECT * FROM points", otherSql="SELECT * FROM points_extra";
  const layer=await createLayer(testAccountScope(), map.id,{name:"changed",sql});
  const unrelated=await createLayer(testAccountScope(), map.id,{name:"unchanged",sql:otherSql});
  const input=(id:string,statement:string)=>({layerId:id,sql:statement,filters:[],geometryColumn:"geometry",columns:["payload"],projection:""});
  ensureTiles(privateTileAccess(testAccountScope(), (input(unrelated.id,otherSql)).layerId), input(unrelated.id,otherSql)); await tileBuildsSettled();
  expect(getTileRecord(unrelated.id)).toMatchObject({state:"ready",error:null});
  const unrelatedRecord=getTileRecord(unrelated.id), unrelatedBytes=await readFile(tileArchivePath(unrelated.id));
  const beforeFingerprint=tileFingerprint(sql,[],"", layer.id), otherFingerprint=tileFingerprint(otherSql,[],"", unrelated.id);
  const started=path.join(dir,"started"),released=path.join(dir,"released"),executable=path.join(dir,"gated-tiler");
  await writeFile(executable,`#!/bin/sh
if [ "$1" = "--version" ]; then exec tippecanoe --version; fi
: > "$DEZFIL_GEOMETRY_TILER_STARTED"
while [ ! -f "$DEZFIL_GEOMETRY_TILER_RELEASE" ]; do sleep 0.01; done
exec tippecanoe "$@"
`,{mode:0o755});
  process.env.DEZFIL_TIPPECANOE=executable; process.env.DEZFIL_GEOMETRY_TILER_STARTED=started; process.env.DEZFIL_GEOMETRY_TILER_RELEASE=released;
  release=()=>writeFile(released,"go");
  ensureTiles(privateTileAccess(testAccountScope(), (input(layer.id,sql)).layerId), input(layer.id,sql));
  await vi.waitFor(()=>expect(existsSync(started),"tiler actually engaged before mutation").toBe(true),{timeout:3000});
  expect(getTileRecord(layer.id)?.state).toBe("building");
  const next=await setGeometry(testAccountScope(), t.name,first.revision,{format:"pair",columns:["x","y"]});
  // This immediate assertion catches omitted prompt invalidation even when
  // a changed fingerprint would lazily repair the next render.
  expect(getTileRecord(layer.id)).toBeNull();
  expect(tileFingerprint(sql,[],"", layer.id)).not.toBe(beforeFingerprint);
  expect(tileFingerprint(otherSql,[],"", unrelated.id)).toBe(otherFingerprint);
  await release(); await tileBuildsSettled();
  expect(getTileRecord(layer.id)).toBeNull(); expect(existsSync(tileArchivePath(layer.id))).toBe(false);
  expect(getTileRecord(unrelated.id)).toEqual(unrelatedRecord);
  expect(await readFile(tileArchivePath(unrelated.id))).toEqual(unrelatedBytes);
  const rows=await boundedEvaluation(async conn=>(await conn.runAndReadAll("SELECT ST_X(geometry) x, ST_Y(geometry) y FROM points")).getRowObjectsJson());
  expect(rows).toEqual([{x:30,y:40},{x:31,y:41}]);
  ensureTiles(privateTileAccess(testAccountScope(), (input(layer.id,sql)).layerId), input(layer.id,sql)); await tileBuildsSettled(); expect(getTileRecord(layer.id)?.state).toBe("ready");
  await clearGeometry(testAccountScope(), t.name,next.revision);
  expect(getTileRecord(layer.id)).toBeNull();
  await expect(boundedEvaluation(conn=>conn.runAndReadAll("SELECT geometry FROM points"))).rejects.toThrow(/geometry|column/i);
});
