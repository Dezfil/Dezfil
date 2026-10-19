import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cssRules } from "../testing/css-rules";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { InviteUserRow } from "./InviteUserRow";

/**
 * The invitation row's admin note sits under the form, inside the
 * invitation, and starts where the table's rows and cells start rather than
 * flush against the table's edge.
 */

const SHEET = "src/components/users/UsersScreen.module.css";

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

/** The left side of a padding shorthand. */
function leftOf(padding: string): string {
  const parts = padding.trim().split(/\s+/);
  return parts[parts.length === 4 ? 3 : parts.length === 1 ? 0 : 1];
}
/** The left padding the selector's last padding declaration sets. */
function paddingLeft(selector: string): string | null {
  const paddings = cssRules(SHEET)
    .filter((r) => r.selector === selector)
    .map((r) => /(?:^|;)\s*padding:\s*([^;]+);/.exec(r.body)?.[1])
    .filter((p): p is string => p !== undefined);
  return paddings.length ? leftOf(paddings[paddings.length - 1]) : null;
}

it("insets the admin note like the table's rows and cells", async () => {
  await act(async () => root.render(<InviteUserRow onCreated={() => {}} onCancel={() => {}} onReactivate={async () => {}} />));
  const admin = container.querySelectorAll("label").find((l) => l.textContent === "Admin")!.querySelector("input")!;
  await act(async () => { admin.checked = true; admin.click(); });
  const note = container.querySelectorAll("p").find((p) => p.textContent.startsWith("Admin access"))!;
  expect(note).toBeTruthy();
  expect(note.parentElement!.className).toMatch(/invitation/);

  const rows = paddingLeft(".rowLine");
  expect(rows).toBe("12px");
  expect(paddingLeft(".newRow")).toBe(rows);
  expect(paddingLeft(".ledger .columns")).toBe(rows);
  expect(paddingLeft(".invitation .note")).toBe(rows);
});
