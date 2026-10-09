import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GOVERNED_REQUESTS } from "./governed-requests";

/**
 * The Private network note's list of governed requests, held against the
 * code: every module that sends a request through the egress check is named
 * by an entry, and every module an entry names sends one. A new road through
 * the check, or one taken out of it, fails here until the list says so.
 */
const ROOT = process.cwd();
const ENGINE = /from\s+["'](?:@\/lib\/net|\.\.?(?:\/\.\.)*(?:\/net)?)\/(egress|remote-fetch)["']/;

/** Modules that import the check without sending a request of their own:
 * the engine itself, and the save-time check on a service address, which
 * only looks a name up. */
const NOT_REQUESTS = ["src/lib/net/remote-fetch.ts", "src/lib/settings/address-admission.ts"];

function sources(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sources(relative);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

const consumers = sources("src")
  .filter(file => ENGINE.test(readFileSync(path.join(ROOT, file), "utf8")))
  .filter(file => !NOT_REQUESTS.includes(file))
  .sort();

describe("the requests the egress check governs", () => {
  it("finds the roads through the check by their imports", () => {
    // The scan itself must see the roads it is meant to see.
    expect(consumers).toContain("src/lib/ingest/remote.ts");
    expect(consumers).toContain("src/lib/osm/overpass.ts");
    expect(consumers).toContain("src/lib/overture/releases.ts");
  });

  it("names every module that sends a request through the check, and no other", () => {
    const named = [...new Set(GOVERNED_REQUESTS.flatMap(request => request.modules))].sort();
    expect(named).toEqual(consumers);
  });

  it("names each request once, in words a person reads", () => {
    const labels = GOVERNED_REQUESTS.map(request => request.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) {
      expect(label).toMatch(/^[A-Z]/);
      expect(label).not.toMatch(/[—–]|DEZFIL_|\.ts\b/);
    }
  });
});
