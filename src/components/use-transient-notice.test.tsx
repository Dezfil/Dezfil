import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { installDomHost } from "./testing/dom-host";
import { useTransientNotice } from "./use-transient-notice";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

it("clears a success after its four seconds, holds a warning or failure, and lets a surface with no dismiss keep the four seconds in any tone", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const host = installDomHost();
  Object.assign(host.window, { setTimeout, clearTimeout });
  let notice!: ReturnType<typeof useTransientNotice>;
  function Probe() {
    notice = useTransientNotice();
    return null;
  }
  const root = createRoot(host.document.body as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  await act(async () => root.render(<Probe />));
  const after = async (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

  await act(async () => notice.show("wells is ready."));
  await after(4000);
  expect([notice.notice, notice.tone]).toEqual([null, "ok"]);

  await act(async () => notice.show("roads.csv could not be imported", "danger"));
  await after(60_000);
  expect([notice.notice, notice.tone]).toEqual(["roads.csv could not be imported", "danger"]);

  await act(async () => notice.show("roads.csv could not be imported", "warn", false));
  await after(3999);
  expect([notice.notice, notice.tone]).toEqual(["roads.csv could not be imported", "warn"]);
  await after(1);
  expect(notice.notice).toBeNull();
});
