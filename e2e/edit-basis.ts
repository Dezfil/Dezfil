import type { Page } from "@playwright/test";
import type { EditBasis } from "../src/lib/edit-basis";
import { captureBasis } from "../scripts/revision-fixtures.mjs";

export interface BrowserAnswer { status: number; json: Record<string, unknown> }
export interface SetupIntent { method: string; path: string; body?: unknown }

/** Raw fixture transport: a missing basis stays missing, and a stale basis
 * stays stale. Authorization and malformed-input probes use this directly. */
export function browserApi(page: Page, method: string, path: string, body?: unknown, basis?: EditBasis): Promise<BrowserAnswer> {
  return page.evaluate(async ({ method, path, body, basis }) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (basis) headers["X-Edit-Revision"] = String(basis.editRevision);
    const response = await fetch(path, { method, headers, cache: "no-store", body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : {} };
  }, { method, path, body, basis });
}

/** Staleness proofs capture before the competing write, then use browserApi. */
export async function captureBrowserBasis(page: Page, path: string): Promise<EditBasis> {
  const read = await browserApi(page, "GET", path);
  if (read.status !== 200) throw new Error(`Cannot capture ${path}: ${read.status}`);
  return captureBasis(read.json);
}

/** Setup only. Intent is formed after this named read. Never use for an
 * already displayed edit or a stale-refusal probe, and never retry a refusal. */
export async function readThenWriteBrowserSetup(page: Page, readPath: string, intent: (shown: Record<string, unknown>) => SetupIntent): Promise<BrowserAnswer> {
  const read = await browserApi(page, "GET", readPath);
  if (read.status !== 200) throw new Error(`Cannot prepare ${readPath}: ${read.status}`);
  const basis = captureBasis(read.json);
  const write = intent(read.json);
  return browserApi(page, write.method, write.path, write.body, basis);
}

/** API-context setup only. Intent is formed after the read, with no retry. */
export async function readThenWriteRequestSetup(
  api: import("@playwright/test").APIRequestContext,
  path: string,
  intent: () => { method: string; path?: string; options?: Parameters<typeof api.fetch>[1] },
) {
  const read = await api.get(path);
  if (!read.ok()) throw new Error(`Cannot prepare ${path}: ${read.status()}`);
  const basis = captureBasis(await read.json());
  const { method, path: writePath = path, options } = intent();
  return api.fetch(writePath, { ...options, method, headers: { ...options?.headers, "X-Edit-Revision": String(basis.editRevision) } });
}

/** Compound setup only: read all selected documents, then form the new
 * filing intent. Displayed-action and stale-refusal tests pass their own bases. */
export async function readThenWriteFilingBrowserSetup(page: Page, selection: Record<string, unknown>, intent: (expectedRevisions: Record<string, string>) => SetupIntent): Promise<BrowserAnswer> {
  const expectedRevisions: Record<string, string> = {};
  for (const key of ["addMaps", "removeMaps", "addRecipes", "removeRecipes"]) {
    const ids = selection[key];
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      const kind = key.endsWith("Maps") ? "map" : "workflow";
      const basis = await captureBrowserBasis(page, `/api/${kind === "map" ? "maps" : "recipes"}/${encodeURIComponent(String(id))}`);
      expectedRevisions[`${kind}:${id}`] = basis.editRevision!;
    }
  }
  const write = intent(expectedRevisions);
  return browserApi(page, write.method, write.path, write.body);
}
