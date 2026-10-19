import { createHash } from "node:crypto";
import path from "node:path";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MapOverview, TableListing } from "./api";
import { cssRules } from "./testing/css-rules";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { SignedIn } from "./sharing/signed-in";
import type { WorkflowListing } from "./workflow-model";
import type { ProjectOverview } from "./projects/model";
import { MapCard, WorkflowCard } from "./projects/ItemCards";
import { ProjectCard } from "./projects/ProjectCollection";
import { TableCard } from "./data-cards";

/**
 * The line under a card's name, a map's, workflow's or dataset's chips, a
 * project's counts or its "Empty", stands the same distance below the name
 * on every card. The suite does not resolve CSS-module composition, so the
 * gap is read back from the stylesheets: each class on the info line, its
 * rule, and any rule it composes.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./MapStrip", () => ({ MapStrip: () => null }));
vi.mock("./WorkflowThumb", () => ({ WorkflowThumb: () => <i data-graph="" /> }));
vi.mock("./projects/ProjectPicture", () => ({ ProjectPicture: () => null }));
vi.mock("./ExportMenu", () => ({ ExportMenu: () => null }));
vi.mock("./gallery-icons", async (original) => ({ ...await original<object>(), MapPlaceholder: () => <i data-placeholder="" /> }));

const SHEETS = [
  "src/components/gallery.module.css",
  "src/components/ProjectsScreen.module.css",
  "src/components/projects/ItemCards.module.css",
  "src/components/TablesScreen.module.css",
];
const hashOf = (file: string) => createHash("sha1").update(file).digest("hex").slice(0, 6);

/** The margin-top a module class sets, its composed classes first. */
function marginTop(name: string, file: string): string | null {
  let out: string | null = null;
  for (const rule of cssRules(file).filter((r) => r.selector === `.${name}`)) {
    const composes = /composes:\s*([\w\s-]+?)(?:\s+from\s+"([^"]+)")?\s*;/.exec(rule.body);
    if (composes) {
      const from = composes[2] ? path.join(path.dirname(file), composes[2]) : file;
      for (const composed of composes[1].trim().split(/\s+/)) out = marginTop(composed, from) ?? out;
    }
    out = /(?:^|;)\s*margin-top:\s*([^;]+);/.exec(rule.body)?.[1].trim() ?? out;
  }
  return out;
}
function resolvedMarginTop(el: HostElement): string | null {
  let out: string | null = null;
  for (const cls of el.className.split(/\s+/).filter(Boolean)) {
    const m = /^_(.+)_([0-9a-f]{6})$/.exec(cls);
    const file = m && SHEETS.find((f) => hashOf(f) === m[2]);
    if (m && file) out = marginTop(m[1], file) ?? out;
  }
  return out;
}

const AT = "2026-10-02T14:00:00Z";
const ada = { name: "Ada Okafor", sqlName: "ada" };
const map = {
  id: "m", name: "Depot", owner: ada, projectId: null, layerCount: 1, layerColors: [], published: true,
  publishToken: "tok", updatedAt: AT, lastChangedAt: AT, lastChangedBy: ada,
} as unknown as MapOverview;
const flow = {
  id: "w", name: "Flow", owner: ada, origin: "workflow", projectId: null, updatedAt: AT, lastChangedAt: AT,
  lastChangedBy: ada, summary: { nodes: 1, sources: 0, liveOutputs: 0, status: "up_to_date", count: 0 }, steps: [],
} as unknown as WorkflowListing;
const table = {
  name: "harbours", rowCount: 12, sizeBytes: 2048, geometryType: "POINT", geometryColumn: "geom",
  createdAt: AT, importedAt: AT, updatedAt: AT, projectIds: [], source: { kind: "upload" },
} as unknown as TableListing;
const project = (counts: Partial<ProjectOverview>) => ({
  id: "p", name: "Harbour study", note: null, updatedAt: AT, mapCount: 0, tableCount: 0, publishedMapCount: 0,
  sizeBytes: 0, sizeComplete: true, ...counts,
}) as unknown as ProjectOverview;

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
});

const projectCard = (p: ProjectOverview) => (
  <ProjectCard project={p} picture={[]} workflowCount={0} groupOf={() => null}
    nameCell={<span>{p.name}</span>} acts={null} onOpen={() => {}} delay={0} />
);
const noop = () => {};
const cases: [string, ReactNode][] = [
  ["a map's chips", <MapCard key="m" map={map} owner={null} />],
  ["a workflow's chips", <WorkflowCard key="w" workflow={flow} lastRun={null} groupOf={() => null} owner={null} />],
  ["a dataset's chips", <TableCard key="t" table={table} index={0}
    actions={{ table, deleting: false, onOpen: noop, onQuery: noop, onAddToMap: noop, onFile: noop, onDelete: noop }} />],
  ["a project's counts", projectCard(project({ mapCount: 2, tableCount: 1, sizeBytes: 4096 }))],
  ["an empty project's Empty", projectCard(project({}))],
];

it.each(cases)("sets %s the same distance under the card's name", async (_name, card) => {
  await act(async () => root.render(<SignedIn account={ada}>{card}</SignedIn>));
  const top = container.querySelectorAll("div").find((d) => /_cardTop_/.test(d.className))!;
  const lines = top.parentElement!.children;
  const info = lines[lines.indexOf(top) + 1];
  expect(info, "a line under the name").toBeTruthy();
  expect(resolvedMarginTop(info)).toBe(marginTop("cardInfo", "src/components/gallery.module.css"));
  expect(resolvedMarginTop(info)).toBe("8px");
});
