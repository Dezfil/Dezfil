import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/components/sql/SqlConsole", () => ({ SqlConsole: () => null }));
vi.mock("@/components/builder/LayerDownloadControlProvider", () => ({ LayerDownloadControlProvider: () => null }));
vi.mock("@/components/screen-defaults", () => ({ ScreenDefaultsProvider: () => null }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/settings/defaults", () => ({ instanceDefaults: vi.fn() }));

import { headers } from "next/headers";
import { instanceDefaults } from "@/lib/settings/defaults";
import SqlPage from "./page";

afterEach(() => vi.resetAllMocks());

it("stops prerendering at the request boundary before reading the settings store", async () => {
  const dynamicRequest = new Error("Request headers are unavailable during prerendering");
  vi.mocked(headers).mockRejectedValue(dynamicRequest);
  vi.mocked(instanceDefaults).mockImplementation(() => { throw new Error("Settings store opened during prerendering"); });
  await expect(Promise.resolve().then(() => SqlPage())).rejects.toBe(dynamicRequest);
  expect(instanceDefaults).not.toHaveBeenCalled();
});
