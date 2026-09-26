import { Suspense, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { TablesScreen } from "@/components/TablesScreen";
import DataPage from "./page";

type ScreenProps = { initialPostgisConnectionId: string | null };

/** The screen sits under the suspense boundary; the handoff
 * contract is the child's. */
async function screenOf(searchParams: {
  source?: string;
  connection?: string;
}): Promise<ReactElement<ScreenProps>> {
  const page = (await DataPage({
    searchParams: Promise.resolve(searchParams),
  })) as ReactElement<{ children: ReactElement<ScreenProps> }>;
  expect(page.type).toBe(Suspense);
  const child = page.props.children;
  expect(child.type).toBe(TablesScreen);
  return child;
}

describe("the Data page's connection handoff", () => {
  it("passes a chosen PostGIS connection into the Add data door", async () => {
    const screen = await screenOf({
      source: "postgis",
      connection: "connection-7",
    });
    expect(screen.props.initialPostgisConnectionId).toBe("connection-7");
  });

  it("ignores a connection id without the PostGIS source door", async () => {
    const screen = await screenOf({ connection: "connection-7" });
    expect(screen.props.initialPostgisConnectionId).toBeNull();
  });
});
