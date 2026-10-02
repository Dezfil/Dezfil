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
