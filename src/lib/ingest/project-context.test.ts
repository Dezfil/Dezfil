import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "./ingest";
import { importOverture } from "@/lib/overture/import";
import { createProject, tableProjectIds } from "@/lib/metadata/projects";
import { listTables } from "@/lib/metadata/tables";
import { POST as uploadRoute } from "@/app/api/tables/route";
import { POST as urlRoute } from "@/app/api/imports/url/route";

/**
 * The import roads' project context: membership commits with registration,
 * an unknown project refuses before source work, and a post-registration
 * membership failure leaves neither a registered dataset nor an artifact
 * behind.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function tableArtifacts(): Promise<string[]> {
  return readdir(path.join(dir, "data", "tables")).catch(() => []);
}

async function csvSource(): Promise<string> {
  const src = path.join(dir, "stations.csv");
  await writeFile(src, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
  return src;
}

describe("the file road", () => {
  it("files the created table in the same act", async () => {
    const p = createProject(testAccountScope(), { name: "A" });
    const src = await csvSource();
    const table = await ingestFile(testAccountScope(), src, "stations.csv", {
      source: "upload",
      sourceParams: null,
      projectId: p.id,
    });
    expect(tableProjectIds().get(table.id)).toEqual([p.id]);
  });

  it("a membership failure after registration succeeds leaves neither table nor artifact", async () => {
    // The seeded defect at the exact boundary: the artifact
    // builds, the registration succeeds inside the transaction, and the
    // filing then fails on a project that does not exist — everything
    // rolls back and the road's own catch removes the artifact.
    const src = await csvSource();
    await expect(
      ingestFile(testAccountScope(), src, "stations.csv", {
        source: "upload",
        sourceParams: null,
        projectId: "p-vanished",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(listTables().length).toBe(0);
    expect(await tableArtifacts()).toEqual([]);
  });
});

describe("route preflight (before any source work)", () => {
  it("the upload road refuses an unknown project before receiving the body", async () => {
    // No file part at all: if the refusal came after receipt this would
    // answer the upload's own invalid_request, not the project's 404.
    const response = await uploadRoute(
      testAccountRequest(new Request("http://test/api/tables?project=p-none", { method: "POST" })),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("the URL road refuses an unknown project before contacting the source", async () => {
    // The URL points at a closed local port: contacting it would answer a
    // transport error, so a clean 404 proves the refusal came first.
    const response = await urlRoute(
      testAccountRequest(new Request("http://test/api/imports/url", {
        method: "POST",
        body: JSON.stringify({
          url: "https://127.0.0.1:1/void.geojson",
          projectId: "p-none",
        }),
      })),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

describe("the Overture road (stub build, the injectable seam)", () => {
  const request = {
    theme: "places",
    scope: { type: "bbox", bbox: [13.3, 52.4, 13.5, 52.6] },
    release: "2026-06-17.0",
    name: "berlin_places",
  };
  const stubBuild = async (
    _params: unknown,
    artifact: string,
  ): Promise<{ geometryColumn: string | null; geometryType: string | null; crsAssumed: boolean; headerSuspect: boolean; rowCount: number }> => {
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, "stub");
    return {
      geometryColumn: "geometry",
      geometryType: "POINT",
      crsAssumed: false,
      headerSuspect: false,
      rowCount: 3,
    };
  };

  it("files the created table in the same act", async () => {
    const p = createProject(testAccountScope(), { name: "A" });
    const table = await importOverture(
      testAccountScope(),
      { ...request, projectId: p.id },
      stubBuild as never,
    );
    expect(tableProjectIds().get(table.id)).toEqual([p.id]);
  });

  it("an unknown project rolls the registration back and removes the artifact", async () => {
    await expect(
      importOverture(testAccountScope(), { ...request, projectId: "p-vanished" }, stubBuild as never),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(listTables().length).toBe(0);
    expect(await tableArtifacts()).toEqual([]);
  });
});

describe("what membership never changes", () => {
  it("dataset names collide instance-wide regardless of project", async () => {
    const a = createProject(testAccountScope(), { name: "A" });
    const b = createProject(testAccountScope(), { name: "B" });
    const first = await ingestFile(testAccountScope(), await csvSource(), "stations.csv", {
      source: "upload",
      sourceParams: null,
      projectId: a.id,
    });
    const second = await ingestFile(testAccountScope(), await csvSource(), "stations.csv", {
      source: "upload",
      sourceParams: null,
      projectId: b.id,
    });
    expect(first.name).toBe("stations");
    expect(second.name).not.toBe("stations");
  });

  it("the repository listing the SQL catalog reads answers filed and unfiled tables alike", async () => {
    const p = createProject(testAccountScope(), { name: "A" });
    const filed = await ingestFile(testAccountScope(), await csvSource(), "stations.csv", {
      source: "upload",
      sourceParams: null,
      projectId: p.id,
    });
    const src = path.join(dir, "loose.csv");
    await writeFile(src, "name,lon,lat\nx,13.4,52.5\n");
    const loose = await ingestFile(testAccountScope(), src, "loose.csv", {
      source: "upload",
      sourceParams: null,
    });
    // listTables is the catalog's source (views.ts); it carries no scope,
    // so what SQL can see never depends on membership.
    const ids = listTables().map((x) => x.id);
    expect(ids).toContain(filed.id);
    expect(ids).toContain(loose.id);
  });
});
