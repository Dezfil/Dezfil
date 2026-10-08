import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceDefaults } from "@/lib/settings/defaults";
import { installDomHost } from "../testing/dom-host";
import { ScreenDefaultsProvider } from "../screen-defaults";
import { SqlConsole } from "./SqlConsole";

/**
 * The SQL console's editor opens at the instance's text size and line wrap
 * as the page handed them down, and at 12 px unwrapped with none handed
 * down. They are taken as the console opens: a later hand-down leaves an
 * open console as it was.
 */

const editors = vi.hoisted(() => ({ props: [] as { textSize?: number; wrap?: boolean }[] }));
// The shared editor loads lazily in every host; here it is a probe that
// keeps what the console hands it.
vi.mock("next/dynamic", () => ({
  default: () => function Editor(props: { textSize?: number; wrap?: boolean }) {
    editors.props.push(props);
    return null;
  },
}));
vi.mock("./use-table-listing", () => ({ useTableListing: () => ({ state: { status: "pending" }, refresh: () => {}, retry: () => {} }) }));
vi.mock("./use-schema-inventory", () => ({
  useSchemaInventory: () => ({ completion: { tables: {} }, get: () => undefined, columnsOf: () => [], progress: null, invalidate: () => {} }),
}));
vi.mock("./SqlAssistantHost", () => ({ useSqlAssistant: () => ({ docked: false, offset: 0 }), SqlAssistantHost: () => null }));
vi.mock("./use-console-splits", () => ({ useConsoleSplits: () => ({ paneWidth: 342, editorHeight: 260, hydrate: () => {}, startDrag: () => {} }) }));
vi.mock("../shell/use-header-reach", () => ({ useHeaderReach: () => {} }));
vi.mock("../use-upload-queue", () => ({ useUploadQueue: () => ({ dismiss: () => {} }) }));
vi.mock("../AddDataDialog", () => ({ AddDataDialog: () => null }));
vi.mock("../AddToMapDialog", () => ({ AddToMapDialog: () => null }));
vi.mock("./ResultsPane", () => ({ ResultsPane: () => null }));
vi.mock("./SnippetsMenu", () => ({ SnippetsMenu: () => null }));
vi.mock("./HistoryList", () => ({ HistoryList: () => null }));
vi.mock("./ConsoleTableBrowser", () => ({ ConsoleTableBrowser: () => null }));

const PRODUCT = {
  "newMap.basemap": null, "newMap.latitude": 40, "newMap.longitude": 0, "newMap.zoom": 1.3, "newMap.legendCorner": null,
  "newLayer.colorCycle": "uber_viz_qualitative", "newLayer.pointOpacity": 72, "newLayer.lineOpacity": 95,
  "newLayer.areaOpacity": 50, "newLayer.lineWidth": 2, "newLayer.pointRadius": 3,
  "canvas.opens": "full", "canvas.minimap": "auto", "canvas.resultsBand": "closed",
  "sqlConsole.textSize": "12", "sqlConsole.lineWrap": false, "imageExport.width": "1920", "imageExport.shape": "4:3",
} as const satisfies InstanceDefaults;
const consoleDefaults = (textSize: "11" | "12" | "13" | "14" | "16", lineWrap: boolean): InstanceDefaults =>
  ({ ...PRODUCT, "sqlConsole.textSize": textSize, "sqlConsole.lineWrap": lineWrap });

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
  editors.props.length = 0;
});

/** Opens the console under the defaults a page handed down (none: no
 * provider at all). */
async function open(defaults: InstanceDefaults | null) {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  const host = installDomHost();
  const kept = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) });
  const root = createRoot(host.document.body as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const render = async (handed: InstanceDefaults | null) => act(async () => {
    root.render(handed ? <ScreenDefaultsProvider defaults={handed}><SqlConsole /></ScreenDefaultsProvider> : <SqlConsole />);
  });
  await render(defaults);
  /** What the console last handed its editor. */
  const editor = () => {
    const last = editors.props.at(-1)!;
    return { textSize: last.textSize, wrap: last.wrap };
  };
  return { render, editor };
}

describe("the SQL console's editor", () => {
  it.each([
    ["11", false],
    ["13", true],
    ["16", true],
  ] as const)("opens at %s px, wrapped %s, as the instance's defaults say", async (size, wrap) => {
    expect((await open(consoleDefaults(size, wrap))).editor()).toEqual({ textSize: Number(size), wrap });
  });

  it("opens at 12 px unwrapped at the product's values and with none handed down", async () => {
    expect((await open(consoleDefaults("12", false))).editor()).toEqual({ textSize: 12, wrap: false });
    expect((await open(null)).editor()).toEqual({ textSize: 12, wrap: false });
  });

  it("stays as it opened when the page hands down other defaults while it is open", async () => {
    const { render, editor } = await open(consoleDefaults("16", true));
    await render(consoleDefaults("11", false));
    expect(editor()).toEqual({ textSize: 16, wrap: true });
  });
});
