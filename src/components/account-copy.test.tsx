import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { WorkspaceCard } from "./settings/WorkspaceCard";
import { TokensCard } from "./settings/TokensCard";
import { McpCard } from "./settings/McpCard";

it("describes the shipped instance settings without promising existing sharing later", () => {
  const html = renderToStaticMarkup(<WorkspaceCard name="Atlas" admin={false} />);
  expect(html).toContain(">Instance</h2>");
  expect(html).not.toMatch(/coming soon|Members &amp; sharing/);
  expect(html).toContain("Only admins can change the instance name.");
});
it("names token reach and the limit of the browser connection check", () => {
  expect(renderToStaticMarkup(<TokensCard admin={false} />)).toContain("Tokens use your current access, including shared projects.");
  const html = renderToStaticMarkup(<McpCard />);
  expect(html).toContain("This checks your browser session.");
  expect(html).toContain("API contract and edit revisions");
});
it("keeps ownership and discard surprises on the surfaces where they occur", () => {
  expect(readFileSync("src/components/sharing/ShareDialog.tsx", "utf8")).toContain("Items keep their owners.");
  expect(readFileSync("src/components/workflow-canvas/CanvasStaleStatus.tsx", "utf8")).toContain("text: DISCARD_MESSAGE");
  expect(readFileSync("src/components/projects/EmptyHome.tsx", "utf8")).not.toContain("Reading the workspace");
});
