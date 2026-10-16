import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostElement, installDomHost } from "../testing/dom-host";
import { Menu, MenuItem } from "./Menu";

/**
 * When an open menu lets go of its trigger. A scroll that moves the
 * trigger strands the menu, so it closes; a scroll that leaves the trigger
 * where it was (one delivered just after the press that opened it, or one
 * elsewhere on the page) does not, and neither does a scroll inside the
 * menu. A resize closes it whatever the trigger did: the menu's place and
 * its height were measured for the window as it was.
 *
 * The host computes no layout, so the trigger's box is the test's: it
 * stands where `trigger` says, and the menu has a fixed size.
 */

const trigger = { top: 200, left: 300 };
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
const proto = HostElement.prototype as unknown as { getBoundingClientRect?: () => object };

beforeEach(() => {
  trigger.top = 200; trigger.left = 300;
  host = installDomHost();
  Object.assign(host.window, { innerWidth: 1440, innerHeight: 1000 });
  proto.getBoundingClientRect = function (this: HostElement) {
    if (this.getAttribute("aria-haspopup") === "menu") {
      return { top: trigger.top, left: trigger.left, bottom: trigger.top + 24, right: trigger.left + 24, width: 24, height: 24 };
    }
    return { top: 0, left: 0, bottom: 120, right: 160, width: 160, height: 120 };
  };
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  act(() => root.render(
    <Menu label="Layer menu" trigger="⋯">
      <MenuItem onSelect={() => {}}>Delete layer</MenuItem>
    </Menu>,
  ));
});
afterEach(() => {
  act(() => root.unmount());
  delete proto.getBoundingClientRect;
  host.uninstall();
});

const button = () => host.document.querySelector('[aria-haspopup="menu"]')!;
const menu = () => host.document.querySelector('[role="menu"]');
const isOpen = () => button().getAttribute("aria-expanded") === "true" && menu() !== null;
function open() {
  act(() => button().click());
  expect(isOpen()).toBe(true);
}
/** A window event as the browser sends it: the window is its target. */
function onWindow(type: "scroll" | "resize") {
  act(() => { host.window.dispatchEvent({ type, target: host.window } as { type: string }); });
}

describe("an open menu", () => {
  it("closes on a resize, though its trigger has not moved", () => {
    open();
    onWindow("resize");
    expect(isOpen()).toBe(false);
  });

  it("stays open on a scroll that leaves its trigger where it was", () => {
    open();
    onWindow("scroll");
    expect(isOpen()).toBe(true);
  });

  it("closes on a scroll that moved its trigger", () => {
    open();
    trigger.top -= 120;
    onWindow("scroll");
    expect(isOpen()).toBe(false);
  });

  it("stays open on a scroll inside itself, its trigger moved or not", () => {
    open();
    trigger.top -= 120;
    act(() => { host.window.dispatchEvent({ type: "scroll", target: menu() } as { type: string }); });
    expect(isOpen()).toBe(true);
  });
});
