import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HostElement, HostEvent, installDomHost } from "../testing/dom-host";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

/**
 * Where keyboard focus stands around a confirmation: back on the element
 * that opened the dialog when it survives; on the page's main heading when
 * the confirmed action removed it (a card's own Delete), never on the
 * document; and inside the open dialog while its confirm button is
 * disabled in flight, on that button again when a refusal re-enables it.
 *
 * The host stores focus and nothing more, so a browser's rules are put in
 * here: an element that is removed, disabled or under an inert ancestor
 * takes no focus, and a control that turns disabled loses it, either at
 * once or after the render, as browsers differ.
 */

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
const hostFocus = HostElement.prototype.focus;
beforeEach(() => {
  host = installDomHost();
  HostElement.prototype.focus = function (this: HostElement) {
    if (!this.isConnected || this.disabled || this.closest("[inert]")) return;
    hostFocus.call(this);
    this.dispatchEvent(new HostEvent("focusin", { bubbles: true }));
  };
  const main = host.document.createElement("main");
  host.document.body.appendChild(main);
  root = createRoot(main as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  HostElement.prototype.focus = hostFocus;
  host.uninstall();
});

/** A card whose own Delete asks first; Delete removes the card, opener and all. */
function Card({ answer }: { answer: () => Promise<boolean> }) {
  const [gone, setGone] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (gone) return null;
  return (
    <>
      <button onClick={() => setOpen(true)}>Delete</button>
      {open && (
        <Dialog label="Delete Depot?" onClose={() => setOpen(false)}>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="danger"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              const deleted = await answer();
              setBusy(false);
              if (deleted) setGone(true);
            }}
          >
            Delete map
          </Button>
        </Dialog>
      )}
    </>
  );
}

const button = (text: string) => host.document.querySelectorAll("button").find((b) => b.textContent === text)!;
const dialog = () => host.document.querySelector('[role="dialog"]');
const heading = () => host.document.querySelector("main")!.querySelectorAll("h1")[0];
/** Where focus stands, in words a failure can be read by. */
function focus(): string {
  const el = host.document.activeElement;
  if (!el) return "the document";
  if (!el.isConnected) return "a removed element";
  if (el.getAttribute("role") === "dialog") return "the dialog";
  return `${el.tagName.toLowerCase()} "${el.textContent}"${el.disabled ? " (disabled)" : ""}`;
}

async function openWith(answer: () => Promise<boolean>) {
  await act(async () => root.render(<><h1>Maps</h1><Card answer={answer} /></>));
  button("Delete").focus();
  await act(async () => button("Delete").click());
  expect(focus()).toBe("the dialog");
}

/** Press Delete map as a keyboard does, the button holding focus. */
async function confirm() {
  button("Delete map").focus();
  await act(async () => button("Delete map").click());
}

it("returns focus to the opener when it survives the dialog", async () => {
  await openWith(async () => true);
  await act(async () => button("Cancel").click());
  expect(dialog()).toBeNull();
  expect(focus()).toBe('button "Delete"');
});

it("puts focus on the page's main heading when the confirmed action removed the opener", async () => {
  await openWith(async () => true);
  await confirm();
  expect(dialog()).toBeNull();
  expect(host.document.querySelectorAll("button")).toHaveLength(0);
  expect(focus()).toBe('h1 "Maps"');
  // Focusable for this landing only: it leaves the tab order with focus.
  expect(heading().getAttribute("tabindex")).toBe("-1");
  await act(async () => heading().dispatchEvent(new HostEvent("blur")));
  expect(heading().hasAttribute("tabindex")).toBe(false);
});

it.each(["at once", "after the render"])(
  "keeps focus in the dialog while the confirm button is disabled (focus lost %s), and on it after a refusal",
  async (when) => {
    let refuse!: () => void;
    await openWith(() => new Promise<boolean>((resolve) => { refuse = () => resolve(false); }));
    const control = button("Delete map");
    if (when === "at once") {
      const set = control.setAttribute.bind(control);
      control.setAttribute = (name: string, value: string) => {
        set(name, value);
        if (name === "disabled") control.blur();
      };
    }
    await confirm();
    if (when === "after the render" && (host.document.activeElement as HostElement | null)?.disabled) host.document.activeElement!.blur();
    expect(control.disabled).toBe(true);
    // Inside the open dialog: the dialog itself, while no control in it may take focus.
    expect(focus()).toBe("the dialog");
    await act(async () => refuse());
    expect(dialog()).not.toBeNull();
    expect(control.disabled).toBe(false);
    expect(focus()).toBe('button "Delete map"');
  },
);
