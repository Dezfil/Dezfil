import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { externalFixture } from "../../../../test-support/external-sign-in";
import { installDomHost, type HostElement } from "@/components/testing/dom-host";
import { SystemTab } from "@/components/settings/SystemTab";
import { storageReadFixture } from "@/components/settings/read-fixture";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import type { readInstanceSettings } from "@/lib/settings/read";
import { GET } from "@/app/api/instance/settings/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { getAccountByEmail } from "@/lib/metadata/accounts";
import { issueSession } from "../credentials";
import { SESSION_COOKIE } from "../http";
import { arriveExternalSignIn } from "./arrival";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
let f: ReturnType<typeof externalFixture>, host: ReturnType<typeof installDomHost>, container: HostElement;
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(async () => {
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET", ""); vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR", "0");
  f = externalFixture(); expect((await arriveExternalSignIn(f.request())).status).toBe(200);
  vi.spyOn(console, "info").mockImplementation(() => {});
  host = installDomHost(); container = host.document.createElement("div"); host.document.body.appendChild(container);
});
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; host.uninstall(); vi.unstubAllGlobals(); f.close(); });
async function read() {
  const account = getAccountByEmail("owner@example.test", f.db)!;
  const secret = issueSession(account, f.db, Date.now()).secret;
  const response = await GET(socketRequest(new Request("https://instance.test/api/instance/settings", { headers: { cookie: `${SESSION_COOKIE}=${secret}` } })));
  expect(response.status).toBe(200);
  return await response.json() as ReturnType<typeof readInstanceSettings>;
}
async function render(answer: Awaited<ReturnType<typeof read>>) {
  if (root) act(() => root!.unmount());
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/instance/settings") return Response.json(answer);
    if (url === "/api/instance/storage") return Response.json(storageReadFixture());
    if (url === "/api/assistant") return Response.json({ enabled: false, reason: "No model key is set." });
    if (url === "/api/health") return Response.json({ status: "ready" });
    throw new Error(`Unexpected request: ${url}`);
  }));
  root = createRoot(container as unknown as Element);
  await act(async () => root!.render(<SystemTab />));
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return container.querySelectorAll("section").find(section => section.querySelector("h2")?.textContent === "External sign-in")!;
}

it.each([true, false])("reports only the last applied reset in the real read and rendered card, with the mode enabled: %s", async enabled => {
  if (!enabled) f.start({ DEZFIL_EXTERNAL_SIGN_IN_KEYS: undefined, DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE: undefined });
  const doc = buildOpenApiDocument();
  const rewrite = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll('"#/components/schemas/', '"#/$defs/'));
  const schema = fromJsonSchema({ ...rewrite(doc.components.schemas.InstanceSettings), $defs: rewrite(doc.components.schemas) });
  const initial = await read();
  expect(initial.externalSignIn.lastReset).toBeNull();
  expect((await schema["~standard"].validate(initial)).issues).toBeUndefined();
  expect((await render(initial)).textContent).toContain("Last door generation resetNone");
  for (const value of [8, 7]) {
    expect(f.start({ DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET: String(value) })).toBe(true);
    const row = f.db.prepare("SELECT value,applied_at FROM auth_door_generation_resets WHERE value=?").get(value) as { value: number; applied_at: string };
    expect(row.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET", "7654321");
    const answer = await read();
    expect(answer.externalSignIn.lastReset).toEqual({ value, appliedAt: row.applied_at });
    expect(answer.settings.externalSignInGenerationReset.value).toEqual({ set: true });
    expect(JSON.stringify(answer)).not.toContain("7654321");
    expect((await schema["~standard"].validate(answer)).issues).toBeUndefined();
    const card = await render(answer);
    expect(card.textContent).toContain(`Last door generation reset${value} · ${row.applied_at}`);
    expect(container.textContent).not.toContain("7654321");
    expect(container.querySelector('[id="env-dezfil-external-sign-in-generation-reset"]')?.textContent).toContain("Set");
    const leaked = structuredClone(answer); leaked.settings.externalSignInGenerationReset.value = 7654321;
    expect((await schema["~standard"].validate(leaked)).issues).toBeDefined();
  }
});
