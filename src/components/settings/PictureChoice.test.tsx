// The picture-card choice: a row of cards, each a picture over its name,
// one of them picked. Mounted through react-dom's client into the stored
// tree host in ../testing/dom-host, in the node environment, so the
// keyboard and the clicks run through React's own handlers. How the cards
// look is the browser round's.
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostEvent, installDomHost, type HostElement } from "../testing/dom-host";
import { PictureChoice } from "./PictureChoice";

const CHOICES = [
  { value: "kelp", label: "Kelp", picture: <i data-art="kelp" /> },
  { value: "harbor", label: "Harbor", picture: <i data-art="harbor" /> },
  { value: "heather", label: "Heather", picture: <i data-art="heather" /> },
  { value: "slate", label: "Slate", picture: <i data-art="slate" /> },
] as const;

describe("the picture-card choice", () => {
  let host: ReturnType<typeof installDomHost>;
  let root: ReturnType<typeof createRoot> | null = null;
  let picks: string[] = [];

  function Held({ start = "kelp", disabled = false }: { start?: string; disabled?: boolean }) {
    const [value, setValue] = useState(start);
    return <PictureChoice label="Color" value={value} choices={CHOICES} disabled={disabled}
      onChange={next => { picks.push(next); setValue(next); }} />;
  }

  async function mount(node: React.ReactNode) {
    const container = host.document.body.appendChild(host.document.createElement("div"));
    root = createRoot(container as unknown as Element);
    await act(async () => { root!.render(node); });
    const group = () => container.querySelector('[role="radiogroup"]')!;
    const radios = () => container.querySelectorAll('[role="radio"]');
    const checked = () => radios().filter(radio => radio.getAttribute("aria-checked") === "true");
    const press = async (key: string) => {
      const target = (host.document.activeElement as HostElement | null) ?? radios()[0];
      await act(async () => { target.dispatchEvent(Object.assign(new HostEvent("keydown", { bubbles: true, cancelable: true }), { key })); });
    };
    return { group, radios, checked, press };
  }

  beforeEach(() => { host = installDomHost(); picks = []; });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    host.uninstall();
  });

  it("is one radio group named by its row, a radio per card named by the card's words", async () => {
    const view = await mount(<Held />);
    expect(view.group().getAttribute("aria-label")).toBe("Color");
    expect(view.radios().map(radio => radio.textContent)).toEqual(["Kelp", "Harbor", "Heather", "Slate"]);
    for (const [index, radio] of view.radios().entries()) {
      // The picture is the card's look, not its name: hidden from the accessible name.
      const art = radio.querySelector("[data-picture-box]")!;
      expect(art.getAttribute("aria-hidden")).toBe("true");
      expect(art.querySelector("[data-art]")!.getAttribute("data-art")).toBe(CHOICES[index].value);
    }
  });

  it("marks the picked card checked and makes it the group's one tab stop", async () => {
    const view = await mount(<Held start="heather" />);
    expect(view.radios().map(radio => radio.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false"]);
    expect(view.radios().map(radio => radio.getAttribute("tabindex"))).toEqual(["-1", "-1", "0", "-1"]);
    expect(view.checked()[0].hasAttribute("data-active")).toBe(true);
  });

  it("moves the pick and the focus with the arrows, wrapping at either end", async () => {
    const view = await mount(<Held />);
    view.radios()[0].focus();
    await view.press("ArrowRight");
    expect(picks).toEqual(["harbor"]);
    expect(view.checked()[0].textContent).toBe("Harbor");
    expect(host.document.activeElement).toBe(view.radios()[1]);
    await view.press("ArrowDown");
    expect(view.checked()[0].textContent).toBe("Heather");
    await view.press("ArrowLeft");
    await view.press("ArrowUp");
    await view.press("ArrowLeft");
    expect(picks).toEqual(["harbor", "heather", "harbor", "kelp", "slate"]);
    expect(host.document.activeElement).toBe(view.radios()[3]);
    // Any other key leaves the pick alone.
    await view.press("Enter");
    expect(picks).toHaveLength(5);
  });

  it("picks a card on a click", async () => {
    const view = await mount(<Held />);
    await act(async () => { view.radios()[2].click(); });
    expect(picks).toEqual(["heather"]);
    expect(view.checked().map(radio => radio.textContent)).toEqual(["Heather"]);
  });

  it("offers no stop and takes no pick while the row is disabled", async () => {
    const view = await mount(<Held disabled />);
    expect(view.group().getAttribute("aria-disabled")).toBe("true");
    expect(view.radios().every(radio => radio.getAttribute("tabindex") === "-1" && radio.hasAttribute("disabled"))).toBe(true);
    await act(async () => { view.radios()[1].click(); });
    expect(picks).toEqual([]);
  });
});
