import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardDelete } from "./CardDelete";
import { ListHeading } from "./ListHeading";
import { installDomHost, type HostElement } from "./testing/dom-host";

/**
 * Where focus goes when a card's in-place delete removes the card holding
 * it: the next card's delete, else the previous card's, else the list's
 * heading; nowhere when the person had already moved on; and back to the
 * button when the deletion fails after its in-flight disabling dropped
 * focus. The list is a stand-in the test redraws as a page would.
 */

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
let settle: () => void;
let confirmed: number;

beforeEach(() => {
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  confirmed = 0;
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
});

const onConfirm = () => { confirmed += 1; return new Promise<void>((resolve) => { settle = resolve; }); };

function draw(items: string[], inFlight: string | null = null) {
  act(() =>
    root.render(
      <>
        <ListHeading title="Maps" line={null} />
        <input aria-label="Search maps" />
        {items.map((name) => (
          <article key={name}>
            <CardDelete
              label={`Delete ${name}`}
              armedLabel={`Confirm deleting ${name}`}
              hint="Delete map"
              question="Delete?"
              disabled={inFlight === name}
              onConfirm={onConfirm}
            />
          </article>
        ))}
      </>,
    ),
  );
}
const button = (label: string) => container.querySelectorAll("button").find((b) => b.getAttribute("aria-label") === label);
const active = () => host.document.activeElement;

/** Arm and confirm from the keyboard, then draw the flight. */
function confirm(name: string, items: string[]) {
  const b = button(`Delete ${name}`)!;
  b.focus();
  act(() => b.click());
  expect(b.getAttribute("aria-label")).toBe(`Confirm deleting ${name}`);
  act(() => b.click());
  draw(items, name);
  return b;
}

describe("a card's in-place delete", () => {
  it("lands on the previous card's delete when the last card goes", async () => {
    draw(["a", "b", "c"]);
    confirm("c", ["a", "b", "c"]);
    draw(["a", "b"]);
    await act(async () => settle());
    expect(active()).toBe(button("Delete b"));
  });

  it("lands on the list's heading when the only card goes, focusable for that landing", async () => {
    draw(["a"]);
    confirm("a", ["a"]);
    draw([]);
    await act(async () => settle());
    const heading = container.querySelector("h1");
    expect(active()).toBe(heading);
    expect(heading?.getAttribute("tabindex")).toBe("-1");
  });

  it("lands when the flight's disabling had already dropped focus on the document", async () => {
    draw(["a", "b"]);
    confirm("a", ["a", "b"]);
    host.document.body.focus();
    draw(["b"]);
    await act(async () => settle());
    expect(active()).toBe(button("Delete b"));
  });

  it("leaves focus where the person moved it while the deletion was in flight", async () => {
    draw(["a", "b"]);
    confirm("a", ["a", "b"]);
    const search = container.querySelector("input")!;
    search.focus();
    draw(["b"]);
    await act(async () => settle());
    expect(active()).toBe(search);
  });

  it("moves nothing when the confirming press came without focus on the button", async () => {
    draw(["a", "b"]);
    const b = button("Delete a")!;
    act(() => b.click());
    act(() => b.click());
    draw(["a", "b"], "a");
    host.document.body.focus();
    draw(["b"]);
    await act(async () => settle());
    expect(active()).toBe(host.document.body);
  });

  it("disarms one card's delete when another is armed, though no blur left it, and leaves focus where it is", async () => {
    // A pointer click that does not focus the button (as some browsers'
    // do not) never blurs the first: arming the second must disarm it.
    draw(["a", "b"]);
    const a = button("Delete a")!;
    act(() => a.click());
    expect(a.getAttribute("aria-label")).toBe("Confirm deleting a");
    const b = button("Delete b")!;
    b.focus();
    act(() => b.click());
    expect(b.getAttribute("aria-label")).toBe("Confirm deleting b");
    expect(a.getAttribute("aria-label")).toBe("Delete a");
    expect(a.hasAttribute("data-confirm")).toBe(false);
    expect(a.textContent).not.toContain("Delete?");
    expect(active()).toBe(b);
    // Back on the first, one press arms it again and deletes nothing.
    act(() => a.click());
    expect(confirmed).toBe(0);
    expect(a.getAttribute("aria-label")).toBe("Confirm deleting a");
    expect(b.getAttribute("aria-label")).toBe("Delete b");
  });

  it("gives focus back to the button and disarms it when the deletion fails", async () => {
    draw(["a", "b"]);
    const b = confirm("a", ["a", "b"]);
    host.document.body.focus();
    draw(["a", "b"]);
    await act(async () => settle());
    expect(active()).toBe(b);
    expect(b.getAttribute("aria-label")).toBe("Delete a");
    expect(b.hasAttribute("data-confirm")).toBe(false);
  });
});
