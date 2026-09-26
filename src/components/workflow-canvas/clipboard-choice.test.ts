import { describe, expect, it } from "vitest";
import { pasteChoice } from "./clipboard-choice";
import { writeClipboardItem, type ClipboardItem } from "./clipboard-items";

const older: ClipboardItem = {
  kind: "node",
  operation: "buffer",
  parameters: { input: "points", distance: 5 },
};
const newer: ClipboardItem = {
  kind: "node",
  operation: "buffer",
  parameters: { input: "vanished", distance: 5 },
};

describe("what a paste takes", () => {
  it("readable text governs when the system write succeeded", () => {
    const text = writeClipboardItem(older);
    expect(
      pasteChoice(text, { item: older, systemWrote: true, lastWritten: text }),
    ).toEqual(older);
  });

  it("the local copy pastes when the event carries no text and the write had failed", () => {
    expect(
      pasteChoice("", { item: newer, systemWrote: false, lastWritten: null }),
    ).toEqual(newer);
    expect(
      pasteChoice("", { item: newer, systemWrote: true, lastWritten: null }),
    ).toBeNull();
  });

  it("after a failed write, readable text this page wrote earlier still governs", () => {
    // The page copied A (written), then B (the write failed). The clipboard
    // holds A. Another tab or app may have put A there afresh, and the
    // inputs are the same either way, so the contract decides: readable
    // text governs except after source invalidation. Whether the page's
    // newer local copy should outrank its own earlier text after a failed
    // write is an open question.
    const olderText = writeClipboardItem(older);
    expect(
      pasteChoice(olderText, {
        item: newer,
        systemWrote: false,
        lastWritten: olderText,
      }),
    ).toEqual(older);
  });

  it("readable text this page wrote earlier pastes as itself when the newest write succeeded", () => {
    // Another tab or app may have put that earlier item back on the
    // clipboard; the readable text governs. Only a newest write known to
    // have failed keeps the local copy over the page's earlier text
    // (found at review).
    const olderText = writeClipboardItem(older);
    const newerText = writeClipboardItem(newer);
    const local = {
      item: newer,
      systemWrote: true,
      lastWritten: newerText,
    };
    expect(pasteChoice(olderText, local)).toEqual(older);
    expect(pasteChoice(newerText, local)).toEqual(newer);
  });

  it("text this page never wrote is something copied elsewhere, and pastes", () => {
    const olderText = writeClipboardItem(older);
    const foreign = writeClipboardItem(newer);
    expect(
      pasteChoice(foreign, {
        item: older,
        systemWrote: false,
        lastWritten: olderText,
      }),
    ).toEqual(newer);
  });
});
