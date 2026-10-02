import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { BASEMAPS } from "@/lib/basemap";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { SignedIn } from "./signed-in";
import { PlainCrumbTail } from "../shell/PlainCrumbTail";
import { CrumbName } from "../WorkflowScreen";
import { HeaderChrome } from "../builder/BuilderChrome";

/**
 * An opened item names its owner when it is not the signed-in person's: the
 * builder, the reader and the workflow canvas carry the lists' pill (the
 * owner's initials, the name on hover) beside the item's name in the header
 * path's last segment. Nothing on one's own items, and no control: only the
 * mark.
 */

const crumbs = vi.hoisted(() => ({ owner: undefined as unknown, facts: undefined as unknown }));
vi.mock("next/navigation", () => ({ usePathname: () => "/maps/m" }));
vi.mock("../builder/export/ExportControl", () => ({ ExportControl: () => null }));
vi.mock("../builder/publish/PublishControl", () => ({ PublishControl: () => null }));
vi.mock("../builder/assistant/AssistantDoor", () => ({ AssistantDoor: () => null }));
vi.mock("../builder/MapPresentation", () => ({ MapPresentation: () => null }));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light", toggle: () => {} }) }));

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };

let host: ReturnType<typeof installDomHost>;
let slot: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = installDomHost();
  for (const id of ["header-crumb-slot", "header-actions-left", "header-actions-right"]) {
    const el = host.document.createElement("span");
    el.setAttribute("id", id);
    host.document.body.appendChild(el);
  }
  slot = host.document.getElementById("header-crumb-slot")!;
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
});
const asBo = (node: React.ReactNode) => act(async () => {
  root.render(<SignedIn account={bo}>{node}</SignedIn>);
});
// The canvas renders its tail where the screen portals it; the others portal it themselves.
const pill = () => host.document.querySelector("[data-owner-pill]");

describe("the plain path tail (the reader, a dataset's page)", () => {
  it("carries Ada's pill beside her map's name", async () => {
    await asBo(<PlainCrumbTail name="Station catchments" owner={ada} />);
    expect(pill()?.getAttribute("data-owner-pill")).toBe("ada");
    expect(pill()?.getAttribute("data-hint")).toBe("Shared by Ada Okafor");
    expect(slot.textContent).toContain("Station catchments");
  });

  it("carries nothing on Bo's own, nor without an owner", async () => {
    await asBo(<><PlainCrumbTail name="Berth occupancy" owner={bo} /><PlainCrumbTail name="Quays" /></>);
    expect(pill()).toBeNull();
  });
});

describe("the workflow canvas's path tail", () => {
  it.each([false, true])("carries Ada's pill beside her workflow's name (read-only %s), and no control", async (readOnly) => {
    await asBo(<CrumbName name="Permit geocoding" owner={ada} onRename={() => {}} readOnly={readOnly} />);
    expect(pill()?.getAttribute("data-owner-pill")).toBe("ada");
    expect(pill()?.matches("button")).toBe(false);
  });

  it("carries nothing on Bo's own", async () => {
    await asBo(<CrumbName name="Vessel density" owner={bo} onRename={() => {}} />);
    expect(pill()).toBeNull();
  });
});

describe("the builder's path tail", () => {
  const map = (owner: typeof ada) =>
    ({ id: "m", name: "Station catchments", publishToken: null, layers: [], owner }) as unknown as MapWithLayers;
  const chrome = (owner: typeof ada) => (
    <HeaderChrome map={map(owner)} projectId="berlin" history={{ canUndo: false, canRedo: false } as never}
      onUndo={() => {}} onRedo={() => {}} onRename={() => {}} assistant={{} as never} onPublishChange={() => {}}
      renders={{}} layerDataDownloads={{} as never} />
  );

  it("carries Ada's pill beside the name an Editor renames", async () => {
    await asBo(chrome(ada));
    expect(pill()?.getAttribute("data-owner-pill")).toBe("ada");
    expect(slot.querySelector('[title="Rename Station catchments"]')).toBeTruthy();
  });

  it("carries nothing on Bo's own map", async () => {
    await asBo(chrome(bo));
    expect(pill()).toBeNull();
  });
});

describe("the reader", () => {
  it("hands the map's owner to its path tail", async () => {
    vi.doMock("../shell/PlainCrumbTail", () => ({
      PlainCrumbTail: (props: { owner?: { sqlName: string }; facts?: unknown }) => {
        crumbs.owner = props.owner; crumbs.facts = props.facts;
        return null;
      },
    }));
    vi.resetModules();
    const { ReaderStage } = await import("../reader/MapReader");
    const map = { id: "m", name: "Station catchments", lastChangedAt: "2026-10-02", lastChangedBy: bo, layers: [], widgets: [], timeline: null, viewport: { lng: 0, lat: 0, zoom: 2 }, owner: ada } as unknown as MapWithLayers;
    renderToStaticMarkup(
      <ReaderStage mapId="m" map={map} projectId={null} renders={{}} basemapUrl="https://tiles.test/style.json"
        basemapOverrideUrl={null} basemapOverrideAttribution={[]} basemaps={BASEMAPS} />,
    );
    expect(crumbs.owner).toEqual(ada);
    expect(crumbs.facts).toEqual({ lastChangedAt: "2026-10-02", lastChangedBy: bo });
    vi.doUnmock("../shell/PlainCrumbTail");
  });
});
