import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetSecretKeyCache } from "@/lib/secrets";
import { writeStoredSettings } from "@/lib/settings/store";
import { listTables } from "@/lib/metadata/tables";
import { ApiError } from "@/lib/api/errors";
import {
  parseRemoteUrl,
  importFromUrl,
  resolveRemoteSource,
  translateObjectUrl,
} from "./remote";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";

// Every request here goes to a loopback fixture; one that went to a public
// store instead (Amazon's or Google's addresses) fails its test before it
// leaves this machine.
keepRequestsOnThisMachine();

/** Single-table imports, unwrapped (made the answer a result set). */
const importOne = async (url: string, name?: string) =>
  (await importFromUrl(testAccountScope(), url, name)).tables[0];

let dir: string;
let server: Server;
let base: string;
let seen: string[];

const csv = "name,lat,lon\nalpha,52.5,13.4\nbeta,48.85,2.35\n";

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  // The egress policy blocks loopback by default; the fixture server
  // lives there, so the suite opts in the way an administrator would.
  process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
  closeMetadataDb();
  seen = [];

  server = createServer((req, res) => {
    seen.push(req.url ?? "");
    if (req.url === "/points.csv" || req.url === "/bucket/dir/points.csv" || req.url === "/base/bucket/a.csv?key=SEEDED-KEY-0003-QUERY") {
      res.writeHead(200, { "content-type": "text/csv" });
      res.end(csv);
    } else if (req.url === "/big.csv" || req.url === "/bucket/big.csv") {
      // Larger than a 1 MB cap, streamed without a content-length header
      // so the mid-flight counter has to catch it.
      res.writeHead(200, { "content-type": "text/csv" });
      res.write("name,value\n");
      const row = `${"x".repeat(1024)},1\n`;
      for (let i = 0; i < 1600; i++) res.write(row);
      res.end();
    } else if (req.url === "/private-bucket/f.csv") {
      res.writeHead(403);
      res.end("AccessDenied");
    } else if (req.url === "/bucket/huge.parquet") {
      res.writeHead(200, { "content-length": String(2 * 1024 * 1024) });
      res.end();
    } else if (req.url === "/hang.csv") {
      /* Accept and never respond */
    } else if (req.url === "/stall.csv") {
      res.writeHead(200, { "content-type": "text/csv" });
      res.write("name,value\n"); // then stall forever
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_REMOTE_MAX_MB;
  delete process.env.DEZFIL_REMOTE_TIMEOUT_S;
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  delete process.env.DEZFIL_S3_ENDPOINT;
  delete process.env.DEZFIL_OBJECT_STORE_CREDENTIALS;
  await rm(dir, { recursive: true, force: true });
});

describe("parseRemoteUrl", () => {
  it("accepts the documented schemes and rejects the rest", () => {
    expect(parseRemoteUrl("https://x.org/a.parquet").filename).toBe(
      "a.parquet",
    );
    expect(parseRemoteUrl("s3://bucket/key/data.csv").scheme).toBe("s3:");
    expect(() => parseRemoteUrl("ftp://x.org/a.csv")).toThrow(
      /Unsupported URL scheme/,
    );
    expect(() => parseRemoteUrl("not a url")).toThrow(/not a valid URL/);
  });

  it("requires a file path with a supported extension", () => {
    expect(() => parseRemoteUrl("https://x.org/")).toThrow(/no file path/);
    // zip is admitted (a Shapefile container).gml is not.
    expect(parseRemoteUrl("https://x.org/archive.zip").filename).toBe(
      "archive.zip",
    );
    expect(() => parseRemoteUrl("https://x.org/data.gml")).toThrow(
      /Supported formats/,
    );
  });
});

describe("importFromUrl over http", () => {
  it("lands a table with url provenance and recognized geometry", async () => {
    const table = await importOne(`${base}/points.csv`);
    expect(table.name).toBe("points");
    expect(table.rowCount).toBe(2);
    expect(table.geometryColumn).not.toBeNull();
    expect(table.source).toBe("url");
    expect(table.sourceParams).toEqual({ url: `${base}/points.csv` });
    expect(table.importedAt).not.toBeNull();
    expect(listTables().map((t) => t.name)).toEqual(["points"]);
  });

  it("honours a requested table name", async () => {
    const table = await importOne(`${base}/points.csv`, "stations_raw");
    expect(table.name).toBe("stations_raw");
  });

  it("fails specifically on a missing remote file, registering nothing", async () => {
    await expect(importFromUrl(testAccountScope(), `${base}/gone.csv`)).rejects.toMatchObject({
      code: "remote_fetch_failed",
    });
    expect(listTables()).toEqual([]);
    // no stray artifacts or temp files either
    const entries = await readdir(path.join(dir, "data", "tmp")).catch(
      () => [],
    );
    expect(entries).toEqual([]);
  });

  it("fails specifically when the connection is refused", async () => {
    await expect(
      importFromUrl(testAccountScope(), "http://127.0.0.1:9/points.csv"),
    ).rejects.toMatchObject({ code: "remote_fetch_failed" });
  });

  it("enforces the remote size cap mid-stream", async () => {
    process.env.DEZFIL_REMOTE_MAX_MB = "1";
    await expect(importFromUrl(testAccountScope(), `${base}/big.csv`)).rejects.toMatchObject({
      code: "remote_too_large",
    });
    expect(listTables()).toEqual([]);
  });

  it("throws ApiError instances agents can branch on", async () => {
    try {
      await importFromUrl(testAccountScope(), `${base}/gone.csv`);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
    }
  });

  it("fails a hung remote with the coded timeout error", async () => {
    process.env.DEZFIL_REMOTE_TIMEOUT_S = "0.2";
    await expect(importFromUrl(testAccountScope(), `${base}/hang.csv`)).rejects.toMatchObject({
      code: "remote_timeout",
      status: 504,
    });
    expect(listTables()).toEqual([]);
  });

  it("fails a transfer that stalls mid-body with the same coded error", async () => {
    process.env.DEZFIL_REMOTE_TIMEOUT_S = "0.2";
    await expect(importFromUrl(testAccountScope(), `${base}/stall.csv`)).rejects.toMatchObject({
      code: "remote_timeout",
    });
    const entries = await readdir(path.join(dir, "data", "tmp")).catch(
      () => [],
    );
    expect(entries).toEqual([]); // the partial download is cleaned up
  });

  it("is blocked by the egress policy without the allowlist", async () => {
    delete process.env.DEZFIL_EGRESS_ALLOWLIST;
    const before = seen.length;
    await expect(importFromUrl(testAccountScope(), `${base}/points.csv`)).rejects.toMatchObject({
      code: "egress_blocked",
      status: 403,
    });
    expect(seen.length).toBe(before); // rejected before any request
  });
});

describe("translateObjectUrl", () => {
  it("maps s3:// to virtual-hosted HTTPS", () => {
    expect(
      translateObjectUrl(parseRemoteUrl("s3://my-bucket/dir/f.parquet")),
    ).toBe("https://my-bucket.s3.amazonaws.com/dir/f.parquet");
  });

  it("falls back to path-style for dotted buckets", () => {
    expect(translateObjectUrl(parseRemoteUrl("s3://my.bucket/f.csv"))).toBe(
      "https://s3.amazonaws.com/my.bucket/f.csv",
    );
  });

  it("maps gs:// to the storage.googleapis.com form", () => {
    expect(
      translateObjectUrl(parseRemoteUrl("gs://open-data/f.geojson")),
    ).toBe("https://storage.googleapis.com/open-data/f.geojson");
  });

  it("honours a custom S3 endpoint, path-style", () => {
    process.env.DEZFIL_S3_ENDPOINT = "http://minio.example:9000/";
    expect(translateObjectUrl(parseRemoteUrl("s3://bucket/f.csv"))).toBe(
      "http://minio.example:9000/bucket/f.csv",
    );
  });

  it("puts the bucket and key under a custom endpoint's own path, its query and credentials kept", () => {
    process.env.DEZFIL_S3_ENDPOINT = "http://SEEDED-KEY-0003-USER:SEEDED-KEY-0003-PASS@minio.example:9000/base?key=SEEDED-KEY-0003-QUERY";
    expect(translateObjectUrl(parseRemoteUrl("s3://bucket/dir/f.csv"))).toBe(
      "http://SEEDED-KEY-0003-USER:SEEDED-KEY-0003-PASS@minio.example:9000/base/bucket/dir/f.csv?key=SEEDED-KEY-0003-QUERY",
    );
    process.env.DEZFIL_S3_ENDPOINT = "http://minio.example:9000/base/?key=SEEDED-KEY-0003-QUERY";
    expect(translateObjectUrl(parseRemoteUrl("s3://bucket/f.csv"))).toBe(
      "http://minio.example:9000/base/bucket/f.csv?key=SEEDED-KEY-0003-QUERY",
    );
  });
});

describe("anonymous object-store road", () => {
  beforeEach(() => {
    process.env.DEZFIL_S3_ENDPOINT = base;
  });

  it("streams an s3:// object through its HTTPS form, path included", async () => {
    const source = await resolveRemoteSource("s3://bucket/dir/points.csv");
    expect(seen).toEqual(["/bucket/dir/points.csv"]);
    await expect(readFile(source.sourcePath, "utf8")).resolves.toBe(csv);
    await source.cleanup();
  });

  it("asks for an object under the S3 address's path, with its query and credentials", async () => {
    process.env.DEZFIL_S3_ENDPOINT = `${base.replace("//", "//SEEDED-KEY-0003-USER:SEEDED-KEY-0003-PASS@")}/base?key=SEEDED-KEY-0003-QUERY`;
    const credentials: (string | undefined)[] = [];
    server.prependListener("request", (req) => credentials.push(req.headers.authorization));
    const source = await resolveRemoteSource("s3://bucket/a.csv");
    expect(seen).toEqual(["/base/bucket/a.csv?key=SEEDED-KEY-0003-QUERY"]);
    expect(credentials).toEqual([`Basic ${Buffer.from("SEEDED-KEY-0003-USER:SEEDED-KEY-0003-PASS").toString("base64")}`]);
    await expect(readFile(source.sourcePath, "utf8")).resolves.toBe(csv);
    await source.cleanup();
  });

  it("enforces the remote cap on the object road, mid-flight", async () => {
    process.env.DEZFIL_REMOTE_MAX_MB = "1";
    await expect(
      resolveRemoteSource("s3://bucket/big.csv"),
    ).rejects.toMatchObject({ code: "remote_too_large", status: 413 });
  });

  it("obeys the egress policy on the object road", async () => {
    delete process.env.DEZFIL_EGRESS_ALLOWLIST;
    await expect(
      resolveRemoteSource("s3://bucket/dir/points.csv"),
    ).rejects.toMatchObject({ code: "egress_blocked" });
    expect(seen).toEqual([]);
  });

  it("names the credential opt-in when an object is denied", async () => {
    await expect(
      resolveRemoteSource("s3://private-bucket/f.csv"),
    ).rejects.toMatchObject({
      code: "remote_fetch_failed",
      message: expect.stringContaining("DEZFIL_OBJECT_STORE_CREDENTIALS"),
    });
  });

  it("refuses anonymous az:// toward the https:// form that works", async () => {
    await expect(
      resolveRemoteSource("az://container/blob.parquet"),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("https://"),
    });
    expect(seen).toEqual([]);
  });
});

describe("credentialed object-store road (opt-in)", () => {
  beforeEach(() => {
    process.env.DEZFIL_S3_ENDPOINT = base;
    process.env.DEZFIL_OBJECT_STORE_CREDENTIALS = "true";
  });

  it("enforces the cap from the anonymous size probe before any read", async () => {
    process.env.DEZFIL_REMOTE_MAX_MB = "1";
    // The fixture answers HEAD with a 2 MB content-length; the rejection
    // must come from the probe — before DuckDB or a credential is touched.
    await expect(
      resolveRemoteSource("s3://bucket/huge.parquet"),
    ).rejects.toMatchObject({ code: "remote_too_large", status: 413 });
    expect(seen).toEqual(["/bucket/huge.parquet"]);
  });
});

describe("a refusal on the cloud-storage road", () => {
  // The S3 address an admin gives may carry a key in its user information
  // and its path; a refusal names the person's own link instead.
  const SEEDS = "SEEDED-KEY-0001";
  let store: Server;
  let origin: string;

  beforeEach(async () => {
    store = createServer((req, res) => {
      if (req.url === `/${SEEDS}-PATH/bucket/hang.csv`) return; // accept, never answer
      if (req.url === `/${SEEDS}-PATH/bucket/cut.csv`) {
        res.writeHead(200, { "content-type": "text/csv" });
        res.write("name,value\n");
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      res.writeHead(404);
      res.end(`no such key under ${req.url}`);
    });
    await new Promise<void>((resolve) => store.listen(0, "127.0.0.1", () => resolve()));
    origin = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (store.listening) await new Promise<void>((resolve) => store.close(() => resolve()));
    vi.unstubAllEnvs();
    resetSecretKeyCache();
  });

  function use(address: string, via: "variable" | "stored") {
    if (via === "variable") { process.env.DEZFIL_S3_ENDPOINT = address; return; }
    vi.stubEnv("DEZFIL_SECRET_KEY", "7a".repeat(32));
    resetSecretKeyCache();
    writeStoredSettings({ s3Endpoint: address }, metadataDb());
  }

  const address = () => origin.replace("//", `//${SEEDS}-USER:${SEEDS}-PASS@`) + `/${SEEDS}-PATH`;

  async function refusal(link: string): Promise<ApiError> {
    try {
      await resolveRemoteSource(link);
    } catch (error) {
      return error as ApiError;
    }
    throw new Error("expected a refusal");
  }

  function namesOnlyTheLink(error: ApiError, link: string) {
    expect(error.message).toContain(link);
    expect(error.message).not.toContain(SEEDS);
    expect(error.message).not.toContain(origin.slice("http://".length));
  }

  it.each(["variable", "stored"] as const)("names the link when the store answers a status (%s)", async (via) => {
    use(address(), via);
    const error = await refusal("s3://bucket/missing.csv");
    expect(error).toMatchObject({ code: "remote_fetch_failed", status: 502 });
    expect(error.message).toMatch(/^The server responded 404 for s3:\/\/bucket\/missing\.csv\./);
    namesOnlyTheLink(error, "s3://bucket/missing.csv");
  });

  it.each(["variable", "stored"] as const)("names the link when the store cannot be reached (%s)", async (via) => {
    use(address(), via);
    await new Promise<void>((resolve) => store.close(() => resolve()));
    const error = await refusal("s3://bucket/points.csv");
    expect(error).toMatchObject({ code: "remote_fetch_failed", status: 502 });
    expect(error.message).toMatch(/^Could not reach the cloud storage holding s3:\/\/bucket\/points\.csv\./);
    namesOnlyTheLink(error, "s3://bucket/points.csv");
  });

  it("names the link when the store does not answer in time", async () => {
    process.env.DEZFIL_REMOTE_TIMEOUT_S = "1";
    use(address(), "variable");
    const error = await refusal("s3://bucket/hang.csv");
    expect(error).toMatchObject({ code: "remote_timeout", status: 504 });
    namesOnlyTheLink(error, "s3://bucket/hang.csv");
  });

  it("names the link when the transfer is cut", async () => {
    use(address(), "variable");
    const error = await refusal("s3://bucket/cut.csv");
    expect(error).toMatchObject({ code: "remote_fetch_failed" });
    expect(error.message).toMatch(/^The download from s3:\/\/bucket\/cut\.csv was interrupted\./);
    namesOnlyTheLink(error, "s3://bucket/cut.csv");
  });

  it("still names a web address it was given, as given", async () => {
    const error = await refusal(`${origin}/${SEEDS}-PATH/elsewhere.csv`);
    expect(error.message).toBe(`The server responded 404 for ${origin}/${SEEDS}-PATH/elsewhere.csv.`);
  });
});
