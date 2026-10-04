import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountActor } from "@/lib/account-actor";
import type { HistoryTarget } from "@/lib/history-targets";
import { LastChanged } from "./LastChanged";
import { RunInitiator } from "./RunInitiator";
import { SharedHistoryControls } from "../builder/SharedHistoryControls";
import { historyControl } from "../builder/shared-history";
const at = "2026-10-01T14:00:00Z";
const actors: (AccountActor | null)[] = [null, { name: "Ada Person", sqlName: "ada_person" }, { deleted: true }];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-04T14:00:00Z")); });
afterEach(() => vi.useRealTimers());
it.each([false, true])("distinguishes deleted, unnamed and named facts with their exact original time, head=%s", head => {
  for (const actor of actors) {
    const value = Object.freeze({ lastChangedAt: at, lastChangedBy: actor });
    const text = renderToStaticMarkup(<LastChanged value={value} head={head} />);
    expect(text).toContain("3 d ago");
    expect(text).toContain(new Date(at).toLocaleString()); expect(value.lastChangedAt).toBe(at);
    if (actor && "deleted" in actor) {
      expect(text).toContain(`title="Changed ${new Date(at).toLocaleString()} by an account that was deleted"`);
      expect(text).toContain("Deleted account · 3 d ago"); expect(text).toContain('data-deleted="true"');
      expect(text).not.toMatch(/Unknown|ada_person|Ada Person|undefined/);
    } else if (actor) { expect(text).toContain("Ada · 3 d ago"); expect(text).toContain("Ada Person (ada_person)"); }
    else { expect(text).toContain("Unknown · 3 d ago"); expect(text).toContain("by an account the record does not name"); }
  }
});
it("shares the italic setting between the two unnamed fact variants", () => {
  const css = readFileSync(new URL("./LastChanged.module.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.fact\[data-unknown\],\s*\.fact\[data-deleted\]\s*\{\s*font-style: italic;/);
});
it.each(["undo", "redo"] as const)("keeps the original author in the %s hint, with no deleted profile tooltip", direction => {
  for (const actor of actors) {
    const target: HistoryTarget = { eligible: true, reason: null, steps: [{ id: "history", scope: "map", targetId: "map", op: "update", author: actor, createdAt: at }] };
    const history = { canUndo: true, canRedo: true, undoTarget: target, redoTarget: target };
    const label = actor && "deleted" in actor ? "Deleted account" : actor ? "Ada Person (ada_person)" : "Unknown";
    const action = `${direction === "undo" ? "Undo" : "Redo"} · ${label} · map · update`;
    expect(historyControl(history, direction).action).toBe(action);
    expect(renderToStaticMarkup(<SharedHistoryControls history={history} onUndo={() => {}} onRedo={() => {}} />)).toContain(action);
    expect(target.steps[0].createdAt).toBe(at);
  }
});
it("uses plain run attribution and exposes a tooltip only for a named actor", () => {
  for (const actor of actors) {
    const text = renderToStaticMarkup(<RunInitiator actor={actor} />);
    if (actor && "deleted" in actor) { expect(text).toContain(">Deleted account</span>"); expect(text).not.toMatch(/title=|data-hint=|<i|<em|Unknown/); }
    else if (actor) { expect(text).toContain('title="Ada Person (ada_person)"'); expect(text).toContain(">Ada</span>"); }
    else { expect(text).toContain(">Unknown</span>"); expect(text).not.toContain("title="); }
  }
});
