import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDomHost } from "../testing/dom-host";
import { SignedIn } from "./signed-in";
import { HeaderChrome } from "../builder/BuilderChrome";
import { CrumbName } from "../WorkflowScreen";
import { PlainCrumbTail } from "../shell/PlainCrumbTail";

vi.mock("next/navigation", () => ({ usePathname: () => "/maps/m" }));
vi.mock("../builder/export/ExportControl", () => ({ ExportControl: () => null }));
vi.mock("../builder/publish/PublishControl", () => ({ PublishControl: () => null }));
vi.mock("../builder/assistant/AssistantDoor", () => ({ AssistantDoor: () => null }));
vi.mock("../builder/MapPresentation", () => ({ MapPresentation: () => null }));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light", toggle() {} }) }));
const facts = { lastChangedAt: "2026-10-02T14:00:00Z", lastChangedBy: { name: "Ada Okafor", sqlName: "ada" } };
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-02T14:03:00Z"));
  host = installDomHost();
  for (const id of ["header-crumb-slot", "header-attribution-slot", "header-actions-left", "header-actions-right"]) {
    const el = host.document.createElement("span"); el.setAttribute("id", id); host.document.body.appendChild(el);
  }
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => { act(() => root.unmount()); host.uninstall(); vi.useRealTimers(); });
it.each(["builder", "canvas", "reader"].flatMap(surface => ["ada", "bo"].map(sqlName => ({ surface, sqlName }))))("keeps the $surface attribution static for $sqlName", async ({ surface, sqlName }) => {
  const props = { name: "Harbour", owner: { name: "Owner", sqlName: "owner" }, facts, onRename() {}, readOnly: true };
  const map = { id: "m", ...props, ...facts, layers: [], publishToken: null };
  await act(async () => root.render(<SignedIn account={{ name: sqlName, sqlName }}>{surface === "builder"
    ? <HeaderChrome map={map as never} projectId="p" history={{ canUndo: false, canRedo: false }} onUndo={() => {}} onRedo={() => {}} onRename={() => {}} assistant={{} as never} onPublishChange={() => {}} renders={{}} layerDataDownloads={{} as never} />
    : surface === "canvas" ? createPortal(<CrumbName {...props} />, host.document.getElementById("header-crumb-slot") as unknown as Element) : <PlainCrumbTail {...props} />}</SignedIn>));
  const fact = host.document.querySelector("[data-last-changed]");
  expect(fact?.closest('[id="header-crumb-slot"]')).toBeNull();
  expect(fact?.closest('[id="header-attribution-slot"]')).not.toBeNull();
  expect(fact?.textContent).toBe("Ada · 3 min ago");
  expect(fact?.getAttribute("title")).toContain("Ada Okafor (ada)");
  expect(fact?.hasAttribute("tabindex")).toBe(false);
  expect(fact?.matches("button")).toBe(false);
  expect(fact?.getAttribute("role")).not.toBe("button");
  expect(fact?.closest("[data-hint]")).toBeNull();
  expect(fact?.querySelector("[tabindex]")).toBeNull();
  expect(fact?.querySelector("button")).toBeNull();
  expect(fact?.querySelector("svg")).toBeTruthy();
  expect(host.document.body.textContent.indexOf("Harbour")).toBeLessThan(host.document.body.textContent.indexOf("Ada ·"));
});
