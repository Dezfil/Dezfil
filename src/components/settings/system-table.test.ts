import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readInstanceSettings } from "@/lib/settings/read";
import { writeStoredSettings } from "@/lib/settings/store";
import { DISCLOSURE_SEEDS, FORBIDDEN_DISCLOSURE, instanceSettingsFixture } from "../../../test-support/instance-settings";
import { LIMITS_LABELS } from "./limits-table";
import { providerName, runningFor, serverSettingsRows } from "./system-table";

/**
 * System's Server settings table, held against the configuration read
 * the server answers: a row per setting a server variable decides, named
 * as Limits names it where Limits draws it, with the value the read
 * discloses and where it came from.
 */

let fixture: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { fixture = instanceSettingsFixture(); });
afterEach(() => fixture.close());
const read = () => JSON.parse(JSON.stringify(readInstanceSettings(fixture.context, fixture.db)));
const byVariable = (rows: ReturnType<typeof serverSettingsRows>, variable: string) => rows.find(row => row.variable === variable)!;

describe("the Server settings table", () => {
  it("has one row per setting a variable decides, in the read's order, and none for the rest", () => {
    const answer = read();
    const rows = serverSettingsRows(answer);
    const expected = Object.entries(answer.settings as Record<string, { environment?: string }>).filter(([, setting]) => setting.environment).map(([key]) => key);
    expect(rows.map(row => row.key)).toEqual(expected);
    expect(rows.map(row => row.key)).not.toContain("instanceName");
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
  });

  it("names a setting Limits draws word for word as its Limits row, and the rest by the read's label", () => {
    const answer = read();
    const rows = serverSettingsRows(answer);
    for (const [key, label] of Object.entries(LIMITS_LABELS)) expect(rows.find(row => row.key === key)?.label).toBe(label);
    expect(byVariable(rows, "DEZFIL_OPERATION_CONCURRENCY").label).toBe("Tools running at once");
    expect(byVariable(rows, "DEZFIL_QUERY_MEMORY_MB").label).toBe(answer.settings.queryMemoryMb.label);
    expect(byVariable(rows, "DEZFIL_GEOCODER_URL").label).toBe("Address finder");
  });

  it("says where each value came from: the environment, the default, or a link to the Limits row that holds it", () => {
    writeStoredSettings({ queryTimeoutS: 90 }, fixture.db);
    vi.stubEnv("DEZFIL_PREVIEW_ROWS", "500");
    const rows = serverSettingsRows(read());
    expect(byVariable(rows, "DEZFIL_QUERY_TIMEOUT_S")).toMatchObject({ value: { text: "90 seconds" }, source: { kind: "stored", href: "/settings/limits#set-query-time" } });
    expect(byVariable(rows, "DEZFIL_PREVIEW_ROWS")).toMatchObject({ value: { text: "500 rows" }, source: { kind: "environment" } });
    expect(byVariable(rows, "DEZFIL_REMOTE_MAX_MB")).toMatchObject({ value: { text: "2,048 MB" }, source: { kind: "default" } });
  });

  it("shows only what the read discloses: an address's scheme and host, whether a key is set, the encryption key's state", () => {
    for (const [variable, value] of Object.entries(DISCLOSURE_SEEDS)) vi.stubEnv(variable, value);
    const rows = serverSettingsRows(read());
    expect(byVariable(rows, "DEZFIL_GEOCODER_URL").value).toEqual({ text: "https://geocoder.example", mono: true });
    expect(byVariable(rows, "ANTHROPIC_API_KEY").value).toEqual({ text: "Set" });
    expect(byVariable(rows, "DEZFIL_SECRET_KEY").value).toEqual({ text: "Set" });
    expect(byVariable(rows, "DEZFIL_OVERTURE_S3_ENDPOINT").value).toEqual({ text: "Set" });
    const shown = JSON.stringify(rows);
    for (const forbidden of FORBIDDEN_DISCLOSURE) expect(shown).not.toContain(forbidden);
  });

  it("says when a key or an address is not set, and where the encryption key lives", () => {
    const rows = serverSettingsRows(read());
    expect(byVariable(rows, "OPENAI_API_KEY").value).toEqual({ text: "Not set", muted: true });
    expect(byVariable(rows, "DEZFIL_ISOCHRONE_URL").value).toEqual({ text: "Not set", muted: true });
    expect(byVariable(rows, "DEZFIL_SECRET_KEY").value).toEqual({ text: "Not created yet", muted: true });
    expect(byVariable(rows, "DEZFIL_OVERPASS_URL").value).toEqual({ text: "https://overpass-api.de", mono: true });
    expect(byVariable(rows, "DEZFIL_TRUSTED_PROXIES").value).toEqual({ text: "None", muted: true });
    expect(byVariable(rows, "DEZFIL_DATA_DIR").value).toEqual({ text: fixture.dir, mono: true });
    expect(byVariable(rows, "DEZFIL_S3_ENDPOINT").value).toEqual({ text: "AWS" });
  });
});

describe("the Status card's words", () => {
  it("says how long the server has run in its largest whole unit", () => {
    const start = Date.parse("2026-10-04T09:00:00.000Z");
    expect(runningFor("2026-10-04T09:00:00.000Z", start + 20_000)).toBe("Running for less than a minute");
    expect(runningFor("2026-10-04T09:00:00.000Z", start + 60_000)).toBe("Running for 1 minute");
    expect(runningFor("2026-10-04T09:00:00.000Z", start + 5 * 3_600_000 + 59 * 60_000)).toBe("Running for 5 hours");
    expect(runningFor("2026-10-04T09:00:00.000Z", start + 3 * 86_400_000 + 1)).toBe("Running for 3 days");
  });

  it("names the assistant's provider", () => {
    expect([providerName("anthropic"), providerName("openai"), providerName("other")]).toEqual(["Anthropic", "OpenAI", "other"]);
  });
});
