import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The engine's lookup, answered by a fixture resolver: every name here is public.
const dns = vi.hoisted(() => ({ lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]) }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));
import { GET, PATCH } from "@/app/api/instance/settings/route";
import { INSTANCE_SETTINGS_SCHEMAS } from "@/lib/api/openapi-instance-settings";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { open } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { authenticateSession, issueSession } from "@/lib/auth/credentials";
import { resetSecretKeyCache } from "@/lib/secrets";
import { testAccountScope } from "@/lib/test-support/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { SETTING_CATALOGUE } from "./catalogue";
import { admitServiceAddresses } from "./address-admission";
import { changeInstanceSettings } from "./change";
import { readInstanceSettings } from "./read";
import { SERVICE_ADDRESS_KEYS, resolveServiceAddress, type ServiceAddressKey } from "./service-address";
import { readStoredSettings, writeStoredSettings } from "./store";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";

/**
 * The four service addresses an admin may store beside their variables:
 * write-only, kept encrypted with the instance's key, read back as scheme
 * and host alone, and resolved for their services as the variable, else
 * the stored address, else the default.
 */
const KEY_A = "1a".repeat(32), KEY_B = "2b".repeat(32);
const SEEDS = ["SEEDED-KEY-0001-USER", "SEEDED-KEY-0001-PATH", "SEEDED-KEY-0001-QUERY"];
const seeded = (host: string) => `https://seed-user:${SEEDS[0]}@${host}:8443/${SEEDS[1]}/api?key=${SEEDS[2]}`;
const ADDRESSES: Record<ServiceAddressKey, { host: string; variable: string; fallback: string | null }> = {
  geocoderUrl: { host: "geocoder.example", variable: "DEZFIL_GEOCODER_URL", fallback: null },
  isochroneUrl: { host: "router.example", variable: "DEZFIL_ISOCHRONE_URL", fallback: null },
  overpassUrl: { host: "osm.example", variable: "DEZFIL_OVERPASS_URL", fallback: "https://overpass-api.de/api/interpreter" },
  s3Endpoint: { host: "objects.example", variable: "DEZFIL_S3_ENDPOINT", fallback: null },
};
const origin = (key: ServiceAddressKey) => `https://${ADDRESSES[key].host}:8443`;

/** Every form a search knows for a seed: as written, percent-encoded,
 * base64, base64url, hex and UTF-16. */
function forms(seed: string): string[] {
  const bytes = Buffer.from(seed, "utf8");
  return [...new Set([seed, encodeURIComponent(seed), bytes.toString("base64"), bytes.toString("base64url"), bytes.toString("hex"),
    Buffer.from(seed, "utf16le").toString("latin1")])];
}
const leaks = (text: string) => SEEDS.flatMap(seed => forms(seed).filter(form => text.includes(form)));

function useKey(hex: string) { vi.stubEnv("DEZFIL_SECRET_KEY", hex); resetSecretKeyCache(); }

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture(); useKey(KEY_A); });
afterEach(() => { f.close(); resetSecretKeyCache(); });

function patch(body: unknown) {
  return PATCH(socketRequest(new Request("http://instance.test/api/instance/settings", { method: "PATCH",
    headers: { cookie: `dezfil_session=${f.admin.secret}`, origin: "http://instance.test", "content-type": "application/json" },
    body: JSON.stringify(body) })));
}

describe("a saved address", () => {
  it.each(SERVICE_ADDRESS_KEYS)("%s reads back as its scheme and host alone, through the change answer and the read", async key => {
    const response = await patch({ [key]: `  ${seeded(ADDRESSES[key].host)}  ` });
    expect(response.status).toBe(200);
    const answer = await response.text();
    const read = await (await GET(f.request())).text();
    for (const body of [answer, read]) {
      expect(JSON.parse(body).settings[key]).toMatchObject({ value: { set: true, origin: origin(key) }, source: "stored",
        locked: false, invalidOverride: false, storedValue: null });
      expect(leaks(body)).toEqual([]);
    }
    // The service, alone, takes the whole address.
    expect(resolveServiceAddress(key, f.db)).toEqual({ address: seeded(ADDRESSES[key].host), source: "stored" });
    // The generic read of stored values never carries it.
    expect(readStoredSettings(f.db)).not.toHaveProperty(key);
    expect(leaks(JSON.stringify(readStoredSettings(f.db)))).toEqual([]);
  });

  it.each(SERVICE_ADDRESS_KEYS)("%s resolves to its default when nothing is stored, and Remove returns it there", async key => {
    expect(resolveServiceAddress(key, f.db)).toEqual({ address: ADDRESSES[key].fallback, source: "default" });
    expect((await patch({ [key]: seeded(ADDRESSES[key].host) })).status).toBe(200);
    const cleared = await (await patch({ [key]: null })).json();
    expect(cleared.settings[key]).toMatchObject({ source: "default", storedValue: null, locked: false });
    expect(cleared.settings[key].value).toEqual(key === "overpassUrl" ? { set: true, origin: "https://overpass-api.de" }
      : key === "s3Endpoint" ? { rule: "aws-bucket-endpoint" } : { set: false });
    expect(resolveServiceAddress(key, f.db)).toEqual({ address: ADDRESSES[key].fallback, source: "default" });
  });

  it.each(SERVICE_ADDRESS_KEYS)("%s is the variable's while the variable is set: the stored address is shadowed and a write is locked", async key => {
    expect((await patch({ [key]: seeded(ADDRESSES[key].host) })).status).toBe(200);
    vi.stubEnv(ADDRESSES[key].variable, ` https://pinned.example/${SEEDS[1]}?key=${SEEDS[2]} `);
    expect(resolveServiceAddress(key, f.db)).toEqual({ address: `https://pinned.example/${SEEDS[1]}?key=${SEEDS[2]}`, source: "environment" });
    const read = readInstanceSettings(f.context, f.db);
    expect(read.settings[key]).toMatchObject({ value: { set: true, origin: "https://pinned.example" }, source: "environment", locked: true, storedValue: null });
    expect(leaks(JSON.stringify(read))).toEqual([]);
    const refused = await patch({ [key]: "https://other.example" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: { code: "setting_locked", message: `${key}: Locked by ${ADDRESSES[key].variable}.` } });
    vi.unstubAllEnvs(); useKey(KEY_A);
    expect(resolveServiceAddress(key, f.db)).toEqual({ address: seeded(ADDRESSES[key].host), source: "stored" });
  });

  it.each([
    ["another scheme", `ftp://seed-user:${SEEDS[0]}@files.example/${SEEDS[1]}`],
    ["2,049 characters", `https://geocoder.example/${SEEDS[1]}/${"a".repeat(2049 - 26 - SEEDS[1].length)}`],
    ["no host", `https:///${SEEDS[1]}?key=${SEEDS[2]}`],
  ])("refuses %s naming the key and repeating nothing, with nothing stored", async (_name, address) => {
    const response = await patch({ previewRows: 200, geocoderUrl: address });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: { code: "invalid_request", message: "geocoderUrl: Expected an http or https address of at most 2048 characters." } });
    expect(leaks(body)).toEqual([]);
    expect(f.db.prepare("SELECT key FROM workspace_settings").all()).toEqual([]);
  });
});

describe("the instance's key", () => {
  it.each(SERVICE_ADDRESS_KEYS)("%s, once the key is replaced, reads set and unreadable and its service is refused, never given the default", async key => {
    expect((await patch({ [key]: seeded(ADDRESSES[key].host) })).status).toBe(200);
    useKey(KEY_B);
    const read = readInstanceSettings(f.context, f.db);
    expect(read.settings[key]).toMatchObject({ value: { set: true, unreadable: true }, source: "stored", locked: false, storedValue: null });
    let refusal: unknown;
    try { resolveServiceAddress(key, f.db); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: "service_address_unreadable", status: 400 });
    expect((refusal as Error).message).toContain(SETTING_CATALOGUE.find(d => d.key === key)!.label);
    expect(leaks(JSON.stringify(read) + (refusal as Error).message)).toEqual([]);
    // Pasting it again under the new key makes it readable; the old row is gone.
    const again = await (await patch({ [key]: seeded(ADDRESSES[key].host) })).json();
    expect(again.settings[key].value).toEqual({ set: true, origin: origin(key) });
    expect(resolveServiceAddress(key, f.db)).toEqual({ address: seeded(ADDRESSES[key].host), source: "stored" });
  });

  it("is touched by no read while nothing is stored", () => {
    vi.stubEnv("DEZFIL_SECRET_KEY", "not-a-key"); resetSecretKeyCache();
    const read = readInstanceSettings(f.context, f.db);
    for (const key of SERVICE_ADDRESS_KEYS) expect(read.settings[key].source).toBe("default");
    for (const key of SERVICE_ADDRESS_KEYS) expect(resolveServiceAddress(key, f.db).source).toBe("default");
  });
});

describe("the metadata database file", () => {
  const opened: Database[] = [];
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(f.dir, "file-store-")); });
  afterEach(() => { for (const db of opened.splice(0)) if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("holds no seeded key, in any form the search knows, after each address is saved, changed and read", async () => {
    const db = open(path.join(dir, "metadata.db")); opened.push(db);
    testAccountScope(db, "owner");
    db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'owner'").run();
    const context = authenticateSession(issueSession(getAccount("owner", db)!, db, Date.now()).secret, db)!;
    const change = async (body: Record<string, string>) => changeInstanceSettings(context, body, db, Date.now(), await admitServiceAddresses(body));
    for (const key of SERVICE_ADDRESS_KEYS) await change({ [key]: `https://first.example/${SEEDS[1]}?key=${SEEDS[2]}` });
    await change(Object.fromEntries(SERVICE_ADDRESS_KEYS.map(key => [key, seeded(ADDRESSES[key].host)])));
    const read = readInstanceSettings(context, db);
    for (const key of SERVICE_ADDRESS_KEYS) expect(read.settings[key].value).toEqual({ set: true, origin: origin(key) });
    // Each row is there, and none of it is the address.
    const rows = db.prepare("SELECT key, value FROM workspace_settings ORDER BY key").all() as { key: string; value: string }[];
    expect(rows.map(row => row.key)).toEqual(["instance.geocoderUrl", "instance.isochroneUrl", "instance.overpassUrl", "instance.s3Endpoint"]);
    db.close();
    const files = readdirSync(dir);
    expect(files).toContain("metadata.db");
    const found = files.flatMap(file => leaks(readFileSync(path.join(dir, file)).toString("latin1")).map(form => `${file}: ${form}`));
    expect(found).toEqual([]);
    for (const row of rows) expect(row.value).not.toMatch(/^https?:/i);
    // The search can see a stored address: written as plain text, it is found.
    const control = open(path.join(dir, "control.db")); opened.push(control);
    control.prepare("INSERT INTO workspace_settings (key, value, updated_at) VALUES (?, ?, ?)").run("instance.geocoderUrl", seeded("geocoder.example"), "now");
    control.close();
    expect(new Set(leaks(readFileSync(path.join(dir, "control.db")).toString("latin1")))).toEqual(new Set(SEEDS));
  });
});

describe("the one door", () => {
  it("to a stored address's plaintext is opened by the service-address resolver alone", () => {
    const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? sources(path.join(dir, entry.name))
        : /\.(ts|tsx|mjs)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
    const callers = [...sources("src"), ...sources("scripts")]
      .filter(file => readFileSync(file, "utf8").includes("readStoredAddress")).sort();
    expect(callers).toEqual([path.join("src", "lib", "settings", "service-address.ts"), path.join("src", "lib", "settings", "store.ts")]);
  });

  it("is never the repository's generic read, whatever is stored", () => {
    writeStoredSettings(Object.fromEntries(SERVICE_ADDRESS_KEYS.map(key => [key, seeded(ADDRESSES[key].host)])), f.db);
    expect(Object.keys(readStoredSettings(f.db))).toEqual([]);
  });
});

describe("the change operation's contract", () => {
  it("takes each address as text and gives none back", () => {
    const patchSchema = INSTANCE_SETTINGS_SCHEMAS.InstanceSettingsPatch.properties as Record<string, Record<string, unknown>>;
    const readSchema = buildOpenApiDocument().components.schemas.InstanceSettings.properties.settings.properties;
    for (const key of SERVICE_ADDRESS_KEYS) {
      expect(patchSchema[key]).toMatchObject({ type: ["string", "null"], pattern: "^\\s*[Hh][Tt][Tt][Pp][Ss]?://[^/\\\\?#\\s]" });
      expect(patchSchema[key].description).toContain("Write-only");
      expect(readSchema[key].properties.storedValue).toEqual({ type: "null" });
      const pattern = new RegExp(patchSchema[key].pattern as string);
      for (const kept of [seeded("a.example"), " http://router.example:8002", "HTTPS://A.EXAMPLE"]) expect(pattern.test(kept), kept).toBe(true);
      for (const refused of ["ftp://a.example", "https:///a", "a.example", ""]) expect(pattern.test(refused), refused).toBe(false);
    }
  });
});
