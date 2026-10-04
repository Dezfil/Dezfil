import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { PgConnection } from "@/lib/metadata/connections";
import { HookHarness } from "../workflow-canvas/hook-harness";
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: (await import("../workflow-canvas/hook-harness")).hookReact.useState }));
import { ConnectionForm } from "./ConnectionForm";

type Props = Record<string, unknown> & { children?: ReactNode };
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function change(element: ReactElement<Props>, value: string) {
  (element.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
const saved: PgConnection = {
  id: "saved", name: "Prior", host: "prior.example.org", port: 5432, database: "prior", username: "reader", ssl: false,
  createdAt: "2026-01-01T00:00:00.000Z", status: "connected", lastCheckedAt: "2026-01-01T00:00:00.000Z", lastCheckError: null, serverVersion: "PostgreSQL 17", postgisVersion: "3.5",
};
const refusal = "This connection string uses the unsupported protection parameter channel_binding; Dezfil supports connection fields and SSL required or not required.";
const forms = {
  uri: "postgres://new:refused-password@refused.example.org:6543/new?channel_binding=require&oauth_client_secret=refused-option-secret&sslmode=require",
  uri_hash: "postgres://new:refused-password@refused.example.org:6543/new?application_name=a#b&Channel_Binding=require&oauth_client_secret=refused-option-secret",
  libpq: "host=refused.example.org port=6543 dbname=new user=new password=refused-password channel_binding='require' oauth_client_secret='refused-option-secret' sslmode=require",
};
const placeholder = "postgres://user:password@host:5432/database?sslmode=require";
afterEach(() => vi.unstubAllGlobals());
for (const placement of ["add", "edit", "pane"] as const) {
  describe(`${placement} production form protection callbacks`, () => {
    for (const [form, refused] of Object.entries(forms)) {
      it(`${form} preserves fields, password, status and submission, then saves corrected input`, async () => {
        const send = vi.fn().mockImplementation(async () => Response.json({ error: { code: "connection_failed", message: "Prior source failure." } }, { status: 502 }));
        vi.stubGlobal("fetch", send);
        vi.stubGlobal("window", { setTimeout: (callback: () => void) => callback() });
        const onSaved = vi.fn();
        const h = new HookHarness(() => ConnectionForm({ mode: placement === "edit" ? "edit" : "add", connection: placement === "edit" ? saved : undefined, layout: placement === "pane" ? "stacked" : "grid", onSaved }));
        const all = () => nodes(h.render());
        const url = () => all().find((n) => n.props.placeholder === placeholder)!;
        const button = () => all().find((n) => n.type === "button" && String(n.props.children).startsWith("Test & save"))!;
        const values = () => all().filter((n) => n.type === "input" && n.props.placeholder !== placeholder).map((n) => [n.props.value, n.props.checked]);
        const status = () => all().find((n) => n.props.role === "alert");
        if (placement === "edit") (all().find((n) => n.props.children === "Paste a new connection URL")!.props.onClick as () => void)();
        change(all().find((n) => n.props.placeholder === "City geodata")!, "Entered name");
        change(url(), "postgres://reader:prior-password@prior.example.org/prior?sslmode=disable");
        (button().props.onClick as () => void)();
        await vi.waitFor(() => expect(status()).toBeDefined());
        const before = values();
        const priorStatus = status();
        send.mockClear();
        change(url(), refused);
        expect.soft(values(), "refused paste fills no fields").toEqual(before);
        expect.soft(status(), "refused paste preserves the prior status").toEqual(priorStatus);
        const notice = all().find((n) => n.props["data-invalid"] === true);
        expect.soft(notice, "the URL error slot remains the refusal surface").toBeDefined();
        expect.soft(nodes(notice).flatMap((n) => n.props.children), "exact refusal copy").toContain(refusal);
        for (const secret of ["refused-password", "refused-option-secret", "refused.example.org", refused]) {
          expect.soft(JSON.stringify(notice) ?? "", "no input echoed in the error").not.toContain(secret);
        }
        expect.soft(send, "paste itself makes no request").not.toHaveBeenCalled();
        expect.soft(button().props.disabled, "prior fields remain submittable").toBe(false);
        (button().props.onClick as () => void)();
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        expect.soft(JSON.parse(send.mock.calls[0][1].body)).toEqual({ name: "Entered name", host: "prior.example.org", port: "5432", database: "prior", username: "reader", password: "prior-password", ssl: false });
        await vi.waitFor(() => expect(status()).toBeDefined());
        change(url(), "postgres://corrected:corrected-password@corrected.example.org/corrected?sslmode=require&channel_binding=prefer");
        expect.soft(all().some((n) => n.props["data-invalid"] === true)).toBe(false);
        expect.soft(status()).toBeUndefined();
        send.mockClear().mockResolvedValue(Response.json({ ...saved, name: "Entered name", host: "corrected.example.org" }));
        (button().props.onClick as () => void)();
        await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
        expect(JSON.parse(send.mock.calls[0][1].body)).toMatchObject({ host: "corrected.example.org", password: "corrected-password", ssl: true });
        expect(send.mock.calls[0][0]).toBe(placement === "edit" ? "/api/connections/postgis/saved" : "/api/connections/postgis");
        expect(all().find((n) => n.props.type === "password")!.props.value).toBe("");
        expect(url().props.value).toBe("");
        h.unmount();
      });
    }
  });
}
