// The record line's cut is font-shaped (PR): the words' width changes
// when the application's face arrives under `font-display: swap`, while
// the stretched box and the fixed line height do not, so a resize
// observation never fires. The line must measure itself again once the
// fonts settle, as the legend's width rule does. Mounted through
// react-dom's client into the stored-tree host, in the node environment:
// no browser, no DOM library. The host computes no layout, so this case
// supplies the widths and flips them where a face swap would; whether the
// predicate reads a painted clip is the browser's case (section 5 of
// e2e/assistant-record.spec.ts).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssistantRecord } from "./AssistantRecord";
import type { RecordEntry } from "./record-projection";
import { HostElement, installDomHost } from "../../testing/dom-host";

const flush = () => new Promise((r) => setTimeout(r, 0));
const port = { active: () => false, start: () => true };
const SENTENCE = "Updated the layer Dynamic park perimeters of the eastern district, 2026 survey";
const entry: RecordEntry = { id: "e", tool: "update_layer", label: SENTENCE, status: "succeeded", inputs: [["id", "l1"]], omitted: false };

describe("the record line after the fonts settle", () => {
  let host: ReturnType<typeof installDomHost>;
  let container: HostElement;
  let root: ReturnType<typeof createRoot>;
  /** What the test says the layout is: the words' own width against the
   * box that shows them. A face swap widens the words, not the box. */
  const size = { words: 300, box: 300 };
  let settleFonts: () => void;
  const rect = (width: number) => ({ width, height: 17, top: 0, left: 0, right: width, bottom: 17, x: 0, y: 0, toJSON: () => ({}) });

  beforeEach(() => {
    host = installDomHost();
    size.words = 300;
    size.box = 300;
    Object.defineProperty(HostElement.prototype, "scrollWidth", { configurable: true, get: () => Math.round(size.words) });
    Object.defineProperty(HostElement.prototype, "clientWidth", { configurable: true, get: () => Math.round(size.box) });
    Object.defineProperty(HostElement.prototype, "getBoundingClientRect", { configurable: true, value: () => rect(size.box) });
    const document = host.document as unknown as {
      createRange: () => unknown; fonts: { ready: Promise<unknown> };
    };
    document.createRange = () => ({ selectNodeContents: () => {}, getBoundingClientRect: () => rect(size.words) });
    document.fonts = { ready: new Promise<void>((resolve) => { settleFonts = resolve; }) };
    container = host.document.body.appendChild(host.document.createElement("div"));
    root = createRoot(container as unknown as Element);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.document.body.removeChild(container);
    host.uninstall();
    for (const key of ["scrollWidth", "clientWidth", "getBoundingClientRect"]) {
      delete (HostElement.prototype as unknown as Record<string, unknown>)[key];
    }
  });

  it("d: words that fit in the fallback face and clip in the loaded one open the expansion with the whole sentence", async () => {
    await act(async () => { root.render(<AssistantRecord layerDataDownloads={port} entries={[entry]} open={["e"]} />); });
    // The fallback face fits: the expansion holds its inputs and no sentence.
    expect(container.querySelectorAll("[data-sentence]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-inputs]")).toHaveLength(1);
    // The application's face arrives: the same words are wider, the box is not.
    size.words = 420;
    await act(async () => { settleFonts(); await flush(); });
    const shown = container.querySelectorAll("[data-sentence]");
    expect(shown).toHaveLength(1);
    expect(shown[0].textContent).toBe(SENTENCE);
  });
});
