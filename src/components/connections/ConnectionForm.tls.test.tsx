import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
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
afterEach(() => vi.unstubAllGlobals());
describe("invalid-paste parity in the production form callbacks", () => {
  it("fills nothing, shows the exact refusal and preserves submission after a refused paste", async () => {
    const send = vi.fn().mockResolvedValue(Response.json({ error: { message: "Source rejected" } }, { status: 502 }));
    vi.stubGlobal("fetch", send);
    const h = new HookHarness(() => ConnectionForm({ mode: "add", onSaved: vi.fn() }));
    const all = () => nodes(h.render());
    const url = () => all().find((n) => n.props.placeholder === "postgres://user:password@host:5432/database?sslmode=require")!;
    const name = all().find((n) => n.props.placeholder === "City geodata")!;
    change(name, "Entered name");
    change(url(), "postgres://reader:prior-secret@prior.example.org/gis?sslmode=disable");
    const inputs = () => all().filter((n) => n.type === "input" && n.props.placeholder !== "postgres://user:password@host:5432/database?sslmode=require").map((n) => [n.props.value, n.props.checked]);
    const before = inputs();
    change(url(), "postgres://new:refused-secret@new.example.org/new?sslmode=verify-full");
    expect(inputs()).toEqual(before);
    const notice = all().find((n) => n.props["data-invalid"] === true)!;
    expect(notice).toBeDefined();
    expect(nodes(notice).flatMap((n) => n.props.children)).toContain("This URL uses an unsupported or conflicting SSL mode; use require for SSL required, or prefer, disable or allow for SSL not required.");
    expect(JSON.stringify(notice)).not.toContain("refused-secret");
    const submit = all().find((n) => n.props.children === "Test & save connection")!;
    expect(submit.props.disabled).toBe(false);
    (submit.props.onClick as () => void)();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(JSON.parse(send.mock.calls[0][1].body)).toMatchObject({ host: "prior.example.org", password: "prior-secret", ssl: false });
    await vi.waitFor(() => expect(all().some((n) => n.props.role === "alert")).toBe(true));
    const alert = all().find((n) => n.props.role === "alert");
    change(url(), "postgres://new:refused-secret@new.example.org/new?sslmode=verify-ca");
    expect(all().find((n) => n.props.role === "alert")).toEqual(alert);
    change(url(), "postgres://new:corrected-secret@new.example.org/new?sslmode=require");
    expect(all().some((n) => n.props["data-invalid"] === true)).toBe(false);
    expect(all().some((n) => n.props.role === "alert")).toBe(false);
    h.unmount();
  });
});
