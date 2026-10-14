import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomHost } from "./testing/dom-host";
import { STORED_VIEW_WAIT_MS, useViewPrefs } from "./use-view-prefs";

/**
 * A list page's view and sort come from the account's stored settings,
 * read once on arrival. A choice the person makes before that read
 * answers is theirs and stays; a field they did not touch still takes the
 * stored value. Until the stored view is known (answered, failed, given
 * up on after a short wait, or overruled by the person's own choice) the
 * hook says so, so a page can hold its list rather than paint the default
 * grid first. The settings read is held open here and then released.
 */

type Sort = "updated" | "name" | "largest";
const SORTS: readonly Sort[] = ["updated", "name", "largest"];

/** The hook's answer drawn as attributes, its two setters as buttons. */
function Probe() {
  const { view, sort, settled, setView, setSort } = useViewPrefs<Sort>(
    "projects",
    "updated",
    SORTS,
  );
  return (
    <div data-view={view} data-sort={sort} data-settled={String(settled)}>
      <button onClick={() => setView("grid")}>grid</button>
      <button onClick={() => setSort("largest")}>largest</button>
    </div>
  );
}

let release: (body: unknown) => void;
let answerWith: (response: Response) => void;
let breakRead: () => void;
let patches: unknown[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  patches = [];
  const stored = new Promise<Response>((resolve, reject) => {
    release = (body) => resolve(Response.json(body));
    answerWith = resolve;
    breakRead = () => reject(new TypeError("Failed to fetch"));
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      if (input === "/api/settings" && init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return Promise.resolve(Response.json({}));
      }
      if (input === "/api/settings") return stored;
      return Promise.reject(new Error(`unexpected ${input}`));
    }),
  );
  host = installDomHost();
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 4; i += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}
const mount = () => act(async () => root.render(<Probe />));
const probe = () => host.document.querySelector("[data-view]")!;
const shown = () => ({
  view: probe().getAttribute("data-view"),
  sort: probe().getAttribute("data-sort"),
});
const settled = () => probe().getAttribute("data-settled");
const press = (label: string) =>
  act(async () => {
    host.document
      .querySelectorAll("button")
      .find((b) => b.textContent === label)!
      .click();
  });
const stored = { viewPrefs: { projects: { view: "list", sort: "name" } } };

describe("the stored view preference against a choice made before it arrives", () => {
  it("applies the stored view and sort when the person has chosen nothing", async () => {
    await mount();
    release(stored);
    await flush();
    expect(shown()).toEqual({ view: "list", sort: "name" });
  });

  it("keeps a view clicked before the stored answer, and still takes the stored sort", async () => {
    await mount();
    await press("grid");
    release(stored);
    await flush();
    expect(shown().view, "the click stands over the stored list view").toBe("grid");
    expect(shown().sort, "the untouched sort takes the stored one").toBe("name");
    expect(patches).toEqual([{ viewPrefs: { projects: { view: "grid" } } }]);
  });

  it("keeps a sort chosen before the stored answer, and still takes the stored view", async () => {
    await mount();
    await press("largest");
    release(stored);
    await flush();
    expect(shown().sort, "the choice stands over the stored name sort").toBe("largest");
    expect(shown().view, "the untouched view takes the stored one").toBe("list");
  });
});

describe("whether the stored view is known yet", () => {
  it("is pending while the read is out, and settled once it answers", async () => {
    await mount();
    await flush();
    expect(settled(), "nothing is known before the answer").toBe("false");
    release(stored);
    await flush();
    expect(settled()).toBe("true");
    expect(shown()).toEqual({ view: "list", sort: "name" });
  });

  it("settles on an answer that stores nothing for the screen, at the defaults", async () => {
    await mount();
    release({ viewPrefs: {} });
    await flush();
    expect(settled()).toBe("true");
    expect(shown()).toEqual({ view: "grid", sort: "updated" });
  });

  it("settles at the defaults when the read is refused", async () => {
    await mount();
    answerWith(Response.json({ error: { code: "internal" } }, { status: 500 }));
    await flush();
    expect(settled()).toBe("true");
    expect(shown()).toEqual({ view: "grid", sort: "updated" });
  });

  it("settles at the defaults when the read fails outright", async () => {
    await mount();
    breakRead();
    await flush();
    expect(settled()).toBe("true");
    expect(shown()).toEqual({ view: "grid", sort: "updated" });
  });

  it("settles on the person's own choice before the answer", async () => {
    await mount();
    await press("largest");
    expect(settled(), "a choice made first needs no stored answer").toBe("true");
  });

  it("gives up on a read that hangs, and a late answer then changes nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await mount();
    await act(async () => {
      vi.advanceTimersByTime(STORED_VIEW_WAIT_MS - 1);
    });
    expect(settled(), "still waiting just inside the bound").toBe("false");
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(settled(), "the defaults stand once the wait is over").toBe("true");
    expect(shown()).toEqual({ view: "grid", sort: "updated" });
    vi.useRealTimers();
    release(stored);
    await flush();
    expect(shown(), "the page keeps what it already shows").toEqual({
      view: "grid",
      sort: "updated",
    });
  });
});
