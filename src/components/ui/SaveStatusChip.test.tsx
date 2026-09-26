import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SaveStatusChip,
  SaveStatusCorner,
  type SaveStatusChannel,
} from "./SaveStatusChip";

const saving: SaveStatusChannel = { key: "saving", message: null };
const notice: SaveStatusChannel = { key: "notice", message: null, announce: true };

/** One chip, a line per channel, and the pieces of it that no
 * pixel check can see — the per-channel announcement, the action that
 * must stay a control, the nodes that must not come and go, and the two
 * channels that must both stay represented in the one pill. */
describe("the save status chip", () => {
  it("rests with its lines, their text away and nothing switched on", () => {
    const html = renderToStaticMarkup(
      <SaveStatusChip channels={[saving, notice]} />,
    );
    expect(html).toContain("data-save-status-chip");
    expect(html).not.toContain("data-on");
    expect(html).not.toContain("data-tone");
    expect(html).not.toContain("Saving");
  });

  it("wears its producer's own words and switches the chip and its line on", () => {
    const html = renderToStaticMarkup(
      <SaveStatusChip
        channels={[{ ...saving, message: { text: "Saving…" } }, notice]}
      />,
    );
    // The chip and the line that carries the message; the resting line
    // stays off.
    expect(html.match(/data-on="true"/g) ?? []).toHaveLength(2);
    expect(html).toContain("Saving…");
    expect(html).not.toContain("data-tone");
  });

  it("holds both channels at once, in the order it was given them", () => {
    const html = renderToStaticMarkup(
      <SaveStatusChip
        channels={[
          { ...saving, message: { text: "Saving…" } },
          { ...notice, message: { text: "Added berlin restaurants to this map" } },
        ]}
      />,
    );
    // One chip, both lines inside it, saving first.
    expect(html.match(/data-save-status-chip/g) ?? []).toHaveLength(1);
    expect(html.indexOf('data-save-status="saving"')).toBeLessThan(
      html.indexOf('data-save-status="notice"'),
    );
    expect(html.indexOf("Saving…")).toBeLessThan(html.indexOf("Added berlin"));
    expect(html.match(/data-on="true"/g) ?? []).toHaveLength(3);
  });

  it("carries the danger tone only on the line whose producer set one", () => {
    const html = renderToStaticMarkup(
      <SaveStatusChip
        channels={[
          { ...saving, message: { text: "Saving…" } },
          { ...notice, message: { text: "Couldn’t save", tone: "bad" } },
        ]}
      />,
    );
    expect(html).toMatch(/data-save-status="notice"[^>]*data-tone="bad"/);
    expect(html).not.toMatch(/data-save-status="saving"[^>]*data-tone/);
    expect(
      renderToStaticMarkup(
        <SaveStatusChip channels={[{ key: "whisper", message: { text: "Saved" } }]} />,
      ),
    ).not.toContain("data-tone");
  });

  it("renders its action as a button, not as text", () => {
    const html = renderToStaticMarkup(
      <SaveStatusChip
        channels={[
          {
            key: "whisper",
            message: {
              text: "Couldn’t save",
              tone: "bad",
              action: { label: "Retry", run: () => {} },
            },
          },
        ]}
      />,
    );
    expect(html).toMatch(/<button type="button"[^>]*>Retry<\/button>/);
  });

  it("has no action, and no button, when its producer offers none", () => {
    const html = renderToStaticMarkup(
      <SaveStatusChip
        channels={[{ key: "whisper", message: { text: "Couldn’t save", tone: "bad" } }]}
      />,
    );
    expect(html).not.toContain("<button");
  });

  it("announces per channel: politely when its channel does, never otherwise", () => {
    const html = renderToStaticMarkup(
      <SaveStatusChip
        channels={[
          { ...saving, message: { text: "Saving…" } },
          { ...notice, message: { text: "Added a layer" } },
        ]}
      />,
    );
    // The builder's saving indication has no live region today and gains
    // none here; its notice keeps its own.
    expect(html.match(/aria-live="polite"/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/data-save-status="notice"[^>]*aria-live="polite"/);
    expect(html).not.toMatch(/data-save-status="saving"[^>]*aria-live/);
    // The chip itself is not a live region: a shared one would announce
    // the silent channel with the speaking one.
    expect(html).not.toMatch(/data-save-status-chip[^>]*aria-live/);
  });

  it("marks a line off from its live signal while its words still stand", () => {
    // The exit hold: a fade cannot fade text
    // that is gone, so the line goes off with its producer while the
    // words it is closing on stay put.
    const html = renderToStaticMarkup(
      <SaveStatusChip
        channels={[{ key: "saving", on: false, message: { text: "Saving…" } }]}
      />,
    );
    expect(html).toContain("Saving…");
    expect(html).not.toContain('data-on="true"');
  });

  it("takes the message as the signal when a channel offers no other", () => {
    const html = renderToStaticMarkup(
      <SaveStatusChip channels={[{ key: "whisper", message: { text: "Saved" } }]} />,
    );
    expect(html.match(/data-on="true"/g) ?? []).toHaveLength(2);
  });

  it("keeps the host's placement class beside its own corner class", () => {
    const html = renderToStaticMarkup(
      <SaveStatusCorner className="hostPlacement" data-save-status-corner>
        <SaveStatusChip channels={[saving]} />
      </SaveStatusCorner>,
    );
    expect(html).toContain("hostPlacement");
    expect(html).toContain("data-save-status-corner");
  });
});
