import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
import { cssRules } from "../testing/css-rules";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { UserRow } from "./UserRow";

/**
 * A person's row on the Users page. The person cell holds the name alone;
 * opened, the row states its facts first (when the account was added, its
 * SQL name), then the actions, and only the two that end or remove an
 * account stand apart on the right in the danger look.
 */

const person: Account = {
  id: "p", name: "Ada Quill", email: "ada@example.test", sqlName: "ada_quill", isAdmin: false, status: "invited",
  isOriginal: false, createdAt: "2026-10-20T09:00:00Z", updatedAt: "2026-10-20T09:00:00Z", lastSignInAt: null,
};

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

function draw(account: Account, { own = false, open = true } = {}) {
  act(() => root.render(<UserRow account={account} own={own} open={open} busy={false} handOver={null}
    onToggle={() => {}} onAccess={async () => true} onReset={async () => true} onDone={() => {}} onDelete={() => {}} />));
  const line = container.querySelector("button[aria-expanded]")!;
  const actions = container.querySelectorAll("button").filter(b => b !== line);
  const named = (text: string) => actions.find(b => b.textContent === text);
  const apart = (button: HostElement | undefined) => /dangerZone/.test(button?.parentElement?.className ?? "");
  return { line, named, apart, facts: container.querySelectorAll("p").find(p => /facts/.test(p.className)) };
}

it("keeps the SQL name out of the person cell and states it with the added date in the opened row", () => {
  const closed = draw(person, { open: false });
  expect(closed.line.textContent).toContain("Ada Quill");
  expect(container.textContent).not.toContain("ada_quill");

  const { facts } = draw(person);
  expect(facts?.textContent).toContain("SQL name ada_quill");
  expect(facts?.textContent).toContain(`Added ${new Date(person.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`);
});

it("sets Deactivate and Delete account apart in the danger look, and only those", () => {
  const invited = draw(person);
  for (const name of ["Deactivate", "Delete account"]) {
    expect(invited.named(name)?.getAttribute("data-variant"), name).toBe("danger");
    expect(invited.apart(invited.named(name)), name).toBe(true);
  }
  for (const name of ["New sign-in link", "Make admin"]) {
    expect(invited.named(name)?.getAttribute("data-variant"), name).not.toBe("danger");
    expect(invited.apart(invited.named(name)), name).toBe(false);
  }

  const off = draw({ ...person, status: "deactivated" });
  expect(off.named("Delete account")?.getAttribute("data-variant")).toBe("danger");
  expect(off.apart(off.named("Delete account"))).toBe(true);
  expect(off.apart(off.named("Reactivate"))).toBe(false);
});

it("states the facts on the person's own row, which offers no Deactivate", () => {
  // Static: the own row's password link prefetches, which the test host cannot run.
  const html = renderToStaticMarkup(<UserRow account={{ ...person, status: "active" }} own open busy={false} handOver={null}
    onToggle={() => {}} onAccess={async () => true} onReset={async () => true} onDone={() => {}} onDelete={() => {}} />);
  expect(html).toContain("ada_quill");
  expect(html).toContain("Change password");
  expect(html).not.toContain(">Deactivate<");
});

it("keeps the danger pair 24px from the everyday actions", () => {
  const zone = cssRules("src/components/users/UsersScreen.module.css").filter(rule => rule.selector === ".dangerZone");
  expect(zone.map(rule => /margin-left:\s*([^;]+);/.exec(rule.body)?.[1])).toEqual(["24px"]);
});
