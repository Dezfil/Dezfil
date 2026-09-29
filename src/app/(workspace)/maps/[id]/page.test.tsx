import { testAccountRequest } from "@/lib/test-support/accounts";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LayerDownloadControlProvider } from "@/components/builder/LayerDownloadControlProvider";
import MapBuilderPage from "./page";

vi.mock("@/components/builder/MapBuilder", () => ({
  MapBuilder: () => null,
}));

vi.mock("next/headers", () => ({ headers: async () => testAccountRequest(new Request("http://instance.test/maps/map-1")).headers }));

const originalQueryTimeout = process.env.DEZFIL_QUERY_TIMEOUT_S;

afterEach(() => {
  if (originalQueryTimeout === undefined) {
    delete process.env.DEZFIL_QUERY_TIMEOUT_S;
  } else {
    process.env.DEZFIL_QUERY_TIMEOUT_S = originalQueryTimeout;
  }
});

async function renderedPage(): Promise<
  ReactElement<{
    preparationTimeoutMs: number;
  }>
> {
  return (await MapBuilderPage({
    params: Promise.resolve({ id: "map-1" }),
    searchParams: Promise.resolve({}),
  })) as ReactElement<{ preparationTimeoutMs: number }>;
}

describe("map builder layer-download control budget", () => {
  it("gives the default 60 second query budget its 30 second response margin", async () => {
    delete process.env.DEZFIL_QUERY_TIMEOUT_S;

    const page = await renderedPage();

    expect(page.type).toBe(LayerDownloadControlProvider);
    expect(page.props.preparationTimeoutMs).toBe(90_000);
  });

  it("derives a non-default client boundary from the live server query budget", async () => {
    process.env.DEZFIL_QUERY_TIMEOUT_S = "7";

    const page = await renderedPage();

    expect(page.type).toBe(LayerDownloadControlProvider);
    expect(page.props.preparationTimeoutMs).toBe(37_000);
  });
});
