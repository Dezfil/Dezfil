import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceDefaults } from "@/lib/settings/defaults";
import { installDomHost } from "./testing/dom-host";
import { ScreenDefaultsProvider } from "./screen-defaults";
import { CatalogWorkbench } from "./builder/add-layer/CatalogWorkbench";
import { OsmPane } from "./OsmPane";
import { OverturePane } from "./OverturePane";

/**
 * The SQL console's text size and line wrap are the console's alone. The
 * three smaller editors keep what they always had, under any page handing
 * down the instance's defaults: OpenStreetMap's and Overture's query
 * editors at 12 px unwrapped, the add-layer workbench's at 12 px wrapped.
 * Each host is mounted under a page handing down 16 px and the wrap, and
 * what it hands the shared editor is read; the editor's look for each is
 * held beside its extensions.
 */

const probes = vi.hoisted(() => ({ editors: [] as Record<string, unknown>[], maps: [] as Record<string, unknown>[] }));
// Every lazily loaded part is a probe: the editor is told apart by its run
// handler, the rest are the panes' maps.
vi.mock("next/dynamic", () => ({
  default: () => function Lazy(props: Record<string, unknown>) {
    (typeof props.onRun === "function" ? probes.editors : probes.maps).push(props);
    return null;
  },
}));
vi.mock("./builder/add-layer/CatalogTableBrowser", () => ({ CatalogTableBrowser: () => null }));

const HANDED = {
  "newMap.basemap": null, "newMap.latitude": 40, "newMap.longitude": 0, "newMap.zoom": 1.3, "newMap.legendCorner": null,
  "newLayer.colorCycle": "uber_viz_qualitative", "newLayer.pointOpacity": 72, "newLayer.lineOpacity": 95,
  "newLayer.areaOpacity": 50, "newLayer.lineWidth": 2, "newLayer.pointRadius": 3,
  "canvas.opens": "full", "canvas.minimap": "auto", "canvas.resultsBand": "closed",
  "sqlConsole.textSize": "16", "sqlConsole.lineWrap": true, "imageExport.width": "1920", "imageExport.shape": "4:3",
} as const satisfies InstanceDefaults;

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
  probes.editors.length = 0;
  probes.maps.length = 0;
});

async function mount(pane: ReactNode) {
  const host = installDomHost();
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  const root = createRoot(host.document.body as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  await act(async () => root.render(<ScreenDefaultsProvider defaults={HANDED}>{pane}</ScreenDefaultsProvider>));
  const press = (label: string) => act(async () => {
    host.document.querySelectorAll("button").find((button) => button.textContent.includes(label))!.click();
  });
  /** What the host last handed its editor: the size and the wrap, as given. */
  const editor = () => {
    const last = probes.editors.at(-1);
    return last ? { textSize: last.textSize, wrap: last.wrap } : null;
  };
  return { press, editor };
}

describe("the smaller SQL editors", () => {
  it("keep the add-layer workbench's editor wrapped at the editor's own size", async () => {
    const { editor } = await mount(
      <CatalogWorkbench listing={{} as never} mapId="m1" draft="SELECT 1" onDraft={() => {}} mode="add" busy={false}
        error={null} onDismissError={() => {}} onCommit={() => {}} />,
    );
    expect(editor()).toEqual({ textSize: undefined, wrap: true });
  });

  it("keep the OpenStreetMap query editor unwrapped at the editor's own size", async () => {
    const { press, editor } = await mount(<OsmPane onTableCreated={() => {}} />);
    // The query opens once there is an area to ask about.
    await act(async () => (probes.maps.at(-1)!.onShape as (shape: unknown) => void)({ kind: "bbox", bbox: [13.3, 52.45, 13.35, 52.5] }));
    expect(editor()).toBeNull();
    await press("Edit query");
    expect(editor()).toEqual({ textSize: undefined, wrap: undefined });
  });

  it("keep the Overture query editor unwrapped at the editor's own size", async () => {
    const { press, editor } = await mount(<OverturePane onTableCreated={() => {}} />);
    expect(editor()).toBeNull();
    await press("View query");
    expect(editor()).toEqual({ textSize: undefined, wrap: undefined });
  });

  it("take their size and wrap from their host alone: the shared editor reads no instance default", () => {
    for (const file of ["src/components/SqlEditor.tsx", "src/components/sql-editor-extensions.ts"]) {
      const imports = readFileSync(path.join(process.cwd(), file), "utf8").match(/^import[^;]+;/gm) ?? [];
      expect(imports.filter((line) => /screen-defaults|@\/lib\/settings/.test(line)), file).toEqual([]);
    }
  });
});
