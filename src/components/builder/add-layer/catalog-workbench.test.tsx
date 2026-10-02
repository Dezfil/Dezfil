import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomHost } from "../../testing/dom-host";
import { CatalogWorkbench } from "./CatalogWorkbench";

/**
 * A refusal the workbench hears twice, once from the preview and once from
 * Add layer, is said once: beside the draft, where the action's outcome
 * stands. A preview refusal that says something else keeps its own note.
 */

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./CatalogTableBrowser", () => ({ CatalogTableBrowser: () => null }));

const REFUSED = 'The dataset "secret" is not available to you.';

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "sql_error", message: REFUSED } }, { status: 400 })));
  host = installDomHost();
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

const bench = (error: string | null) => (
  <CatalogWorkbench listing={{} as never} mapId="m1" draft="SELECT * FROM secret" onDraft={vi.fn()} mode="add"
    busy={false} error={error} onDismissError={vi.fn()} onCommit={vi.fn()} />
);
const said = (message: string) => host.document.body.textContent.split(message).length - 1;

async function previewRefused() {
  await act(async () => root.render(bench(null)));
  const run = host.document.querySelectorAll("button").find((b) => b.textContent.startsWith("Run preview"))!;
  await act(async () => run.click());
  expect(said(REFUSED)).toBe(1);
}

describe("the workbench's refusals", () => {
  it("says a refusal the preview and Add layer both met once", async () => {
    await previewRefused();
    await act(async () => root.render(bench(REFUSED)));
    expect(said(REFUSED)).toBe(1);
  });

  it("keeps both notes when they say different things", async () => {
    await previewRefused();
    await act(async () => root.render(bench("The layer could not be saved.")));
    expect(said(REFUSED)).toBe(1);
    expect(said("The layer could not be saved.")).toBe(1);
  });
});
