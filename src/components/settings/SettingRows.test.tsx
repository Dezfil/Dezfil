import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { settingDefinition } from "@/lib/settings/catalogue";
import { disclosedDefinition } from "@/lib/settings/disclosure";
import { formatSettingNumber, serverSetState, unitControlFor, type ReadSetting } from "./server-set";
import { LockedField, SettingRow, ValueText } from "./SettingRows";

/**
 * How a setting the server decides is drawn: pinned by the environment,
 * fixed (changed only by a variable and a restart, or not at all), or
 * pinned by a value the server could not use. Fixtures are built from the
 * catalogue's own definitions, shaped as the configuration read reports
 * them.
 */

function read(key: string, resolved: Partial<Pick<ReadSetting, "value" | "source" | "locked" | "invalidOverride" | "storedValue">>): ReadSetting {
  const definition = disclosedDefinition(settingDefinition(key));
  return { ...definition, value: definition.defaultValue, source: "default", locked: false, invalidOverride: false, storedValue: null, ...resolved } as ReadSetting;
}

const markup = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const ENTITIES: Record<string, string> = { "&#x27;": "'", "&quot;": "\"", "&lt;": "<", "&gt;": ">", "&amp;": "&" };
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&quot;|&lt;|&gt;|&amp;/g, entity => ENTITIES[entity]);

describe("the state of a setting the server decides", () => {
  it("leaves an editable, unpinned setting to its own control", () => {
    expect(serverSetState(read("previewRows", { value: 2000, source: "stored", storedValue: 2000 }))).toBeNull();
  });

  it("names the variable that pins a setting", () => {
    expect(serverSetState(read("uploadMaxMb", { value: 8192, source: "environment", locked: true })))
      .toEqual({ kind: "locked", variable: "DEZFIL_UPLOAD_MAX_MB", invalid: false });
  });

  it("says when the value that pins a setting could not be used", () => {
    expect(serverSetState(read("queryTimeoutS", { value: 60, source: "default", locked: true, invalidOverride: true })))
      .toEqual({ kind: "locked", variable: "DEZFIL_QUERY_TIMEOUT_S", invalid: true });
  });

  it("names the variable a fixed setting changes by, and none when it has none", () => {
    expect(serverSetState(read("renderCapFeatures", {}))).toEqual({ kind: "fixed", variable: "DEZFIL_RENDER_CAP_FEATURES" });
    expect(serverSetState(read("renderCapFeatures", { value: 500000, source: "environment", locked: true })))
      .toEqual({ kind: "locked", variable: "DEZFIL_RENDER_CAP_FEATURES", invalid: false });
    expect(serverSetState({ editable: false, locked: false, invalidOverride: false })).toEqual({ kind: "fixed", variable: null });
  });
});

describe("a setting in the save unit", () => {
  it("takes an editable setting's range and default from the read", () => {
    expect(unitControlFor(read("queryTimeoutS", { value: 90, source: "stored", storedValue: 90 })))
      .toEqual({ key: "queryTimeoutS", kind: "number", min: 5, max: 600, locked: false, defaultValue: 60 });
    expect(unitControlFor(read("landingPage", { value: "maps", source: "stored", storedValue: "maps" })))
      .toEqual({ key: "landingPage", kind: "choice", locked: false, defaultValue: "home" });
  });

  it("marks a number that takes decimals with its range, keeps a whole number whole, and draws a switch as one", () => {
    expect(unitControlFor(read("newLayer.lineWidth", { value: 2.5, source: "stored", storedValue: 2.5 })))
      .toEqual({ key: "newLayer.lineWidth", kind: "number", min: 0.5, max: 50, decimal: true, locked: false, defaultValue: 2 });
    expect(unitControlFor(read("newMap.latitude", {})))
      .toEqual({ key: "newMap.latitude", kind: "number", min: -85, max: 85, decimal: true, locked: false, defaultValue: 40 });
    expect(unitControlFor(read("newLayer.pointOpacity", {})))
      .toEqual({ key: "newLayer.pointOpacity", kind: "number", min: 10, max: 100, locked: false, defaultValue: 72 });
    expect(unitControlFor(read("sqlConsole.lineWrap", { value: true, source: "stored", storedValue: true })))
      .toEqual({ key: "sqlConsole.lineWrap", kind: "switch", locked: false, defaultValue: false });
    // A number-like choice stays a choice: its words are the page's.
    expect(unitControlFor(read("sqlConsole.textSize", {})))
      .toEqual({ key: "sqlConsole.textSize", kind: "choice", locked: false, defaultValue: "12" });
  });

  it("keeps a pinned or fixed setting out of Save, Reset and the guard", () => {
    expect(unitControlFor(read("queryTimeoutS", { value: 120, source: "environment", locked: true, storedValue: 90 })))
      .toMatchObject({ key: "queryTimeoutS", locked: true });
    expect(unitControlFor(read("renderCapFeatures", {}))).toMatchObject({ locked: true });
    expect(unitControlFor(read("renderCapFeatures", {}))).not.toHaveProperty("defaultValue");
  });

  it("offers no Reset for a card that has nothing to return to", () => {
    expect(unitControlFor(read("instanceName", { value: "Atlas", source: "stored", storedValue: "Atlas" }), { reset: false }))
      .toEqual({ key: "instanceName", kind: "text", locked: false });
  });
});

describe("the locked field", () => {
  it("draws a pinned setting disabled, with a lock and the variable's sentence", () => {
    const html = markup(<LockedField label="Largest upload" value="8,192 MB"
      state={{ kind: "locked", variable: "DEZFIL_UPLOAD_MAX_MB", invalid: false }} />);
    expect(html).toMatch(/<input[^>]*disabled=""/);
    expect(html).toContain('value="8,192 MB"');
    expect(html).toContain('aria-label="Largest upload"');
    expect(html).toContain("<svg");
    expect(text(html)).toBe("Set in the server's environment by DEZFIL_UPLOAD_MAX_MB.");
    expect(html).toContain("<code>DEZFIL_UPLOAD_MAX_MB</code>");
  });

  it("draws a fixed setting the same way, with the variable it changes by", () => {
    const html = markup(<LockedField label="Features drawn per layer" value="250,000 features"
      state={{ kind: "fixed", variable: "DEZFIL_RENDER_CAP_FEATURES" }} />);
    expect(html).toMatch(/<input[^>]*disabled=""/);
    expect(text(html)).toBe("Changes with DEZFIL_RENDER_CAP_FEATURES when the server restarts.");
  });

  it("draws a fixed setting with no variable without any sentence", () => {
    const html = markup(<LockedField label="Largest image" value="4,096 px per side" state={{ kind: "fixed", variable: null }} />);
    expect(html).toMatch(/<input[^>]*disabled=""/);
    expect(html).toContain('value="4,096 px per side"');
    expect(text(html)).toBe("");
  });

  it("draws an invalid override with the default it falls back to, saying so", () => {
    const setting = read("queryTimeoutS", { value: 60, source: "default", locked: true, invalidOverride: true, storedValue: 90 });
    const html = markup(<LockedField label="Query time limit" value={`${formatSettingNumber(setting.value)} seconds`} state={serverSetState(setting)!} />);
    expect(html).toContain('value="60 seconds"');
    expect(html).not.toMatch(/90 seconds|value="90/);
    expect(text(html)).toBe("DEZFIL_QUERY_TIMEOUT_S in the server's environment is not valid, so the default is used.");
  });
});

describe("rows and read-only values", () => {
  it("lays a row out as its label, its meta line and its control, the control named by the label", () => {
    const html = markup(<SettingRow id="set-query-time" label="Query time limit" meta="Also applies to published maps." after="Running for 3 days">
      <ValueText>60 seconds</ValueText>
    </SettingRow>);
    expect(html).toContain('id="set-query-time"');
    expect(html).toContain('<b id="set-query-time-label">Query time limit</b>');
    expect(html).toContain('role="group" aria-labelledby="set-query-time-label"');
    expect(text(html)).toBe("Query time limitAlso applies to published maps.60 secondsRunning for 3 days");
  });

  it("shows a read-only value in full ink, or in the code face for a path", () => {
    expect(markup(<ValueText>Up to 27 addresses per run</ValueText>)).toMatch(/^<span class="[^"]+">Up to 27 addresses per run<\/span>$/);
    expect(markup(<ValueText mono>/data</ValueText>)).toContain('data-mono="true"');
  });

  it("writes numbers with their grouping", () => {
    expect(formatSettingNumber(5120)).toBe("5,120");
    expect(formatSettingNumber(250000)).toBe("250,000");
    expect(formatSettingNumber(60)).toBe("60");
  });
});
