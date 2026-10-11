import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { drainAccountWork } from "@/lib/auth/account-deletion-admission";
import { EvaluationCancelled } from "@/lib/api/errors";
import { renderMapImage, renderQueueState, type RenderBrowser } from "./render-image";
import { drainAccountRenders, renderWorkForTests, trackRenderWork } from "./render-work";
import type { ExportImageDefinition } from "./image-definition";

let db: ReturnType<typeof metadata.open>;
const definition: ExportImageDefinition = {
  viewport: { lng: 0, lat: 0, zoom: 2, pitch: 0, bearing: 0 }, size: { width: 64, height: 64 }, mapScale: 1,
  legend: { visible: false, corner: "top-right", size: "m" }, widgets: [], title: null, appearance: "light",
};
beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); });

it.each(["timeout", "cancellation"])("deletion waits for a launch abandoned by %s and observes the late kill", async ending => {
  const scope = testAccountScope(db, "target"), abort = new AbortController();
  const late = Promise.withResolvers<RenderBrowser>(), entered = Promise.withResolvers<void>();
  const control = Promise.withResolvers<void>();
  trackRenderWork("control", control.promise);
  const browser: RenderBrowser = {
    render: vi.fn(async () => ({ png: new Uint8Array([137]) })), close: vi.fn(async () => {}), kill: vi.fn(),
  };
  const launch = vi.fn(() => { entered.resolve(); return late.promise; });
  const deadline = Date.now() + 300;
  const pending = renderMapImage(scope, {
    mapId: "pending", definition, credential: "fixture", baseUrl: "http://127.0.0.1:3216/",
    signal: abort.signal, budgetMs: 300, driver: { launch },
  }).catch(error => error);
  try {
    await entered.promise;
    expect(launch).toHaveBeenCalledWith(expect.any(String), expect.any(Array), {
      appOrigin: "http://127.0.0.1:3216", deadline, requestBoundMs: 100, signal: abort.signal,
      launchTimeoutMs: 300, stop: expect.any(AbortSignal), exited: expect.any(Function),
    });
    db.exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
    if (ending === "cancellation") abort.abort();
    else await vi.advanceTimersByTimeAsync(300);
    const error = await pending;
    if (ending === "cancellation") expect(error).toBeInstanceOf(EvaluationCancelled);
    else expect(error).toMatchObject({ code: "render_timeout" });
    // The launch it gave up on still holds the slot, under the bound on its end.
    expect(renderQueueState()).toEqual({ active: 1, waiting: 0 });
    expect(vi.getTimerCount()).toBe(1);

    let accountDrained = false, renderDrained = false;
    const draining = Promise.all([
      drainAccountWork("target", db).then(() => { accountDrained = true; }),
      drainAccountRenders("target").then(() => { renderDrained = true; }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(accountDrained).toBe(false);
    expect(renderDrained).toBe(false);
    expect(renderWorkForTests("target")).toBe(1);
    late.resolve(browser);
    await draining;
    expect(browser.kill).toHaveBeenCalledOnce();
    expect(browser.render).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    expect(renderWorkForTests("target")).toBe(0);
    expect(renderWorkForTests("control")).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    abort.abort(); late.resolve(browser); control.resolve();
    await pending;
    await Promise.all([drainAccountWork("target", db), drainAccountRenders("target"), drainAccountRenders("control")]);
  }
});
