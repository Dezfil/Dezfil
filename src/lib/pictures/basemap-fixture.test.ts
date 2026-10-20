import { expect, it } from "vitest";
import { closedPictureAddress, pictureBasemap } from "../../../test-support/picture-basemap";

it("the unreachable-address fixture really refuses a socket", async () => {
  const closed = await closedPictureAddress();
  await expect(closed.assertClosed()).resolves.toBeUndefined();
});

it("the abandoned-request fixture serves its style but never answers the held tile", async () => {
  const fixture = await pictureBasemap();
  const controller = new AbortController();
  try {
    const style = await (await fetch(`${fixture.origin}/stall.json`)).json();
    expect(style.sources.land.tiles).toEqual([`${fixture.origin}/stall/{z}/{x}/{y}.png`]);
    let answered = false;
    const request = fetch(`${fixture.origin}/stall/10/550/512.png`, { signal: controller.signal }).then(() => { answered = true; }, () => {});
    await expect.poll(() => fixture.traffic().held).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(answered).toBe(false);
    controller.abort(); await request;
    await expect.poll(() => fixture.traffic().closed).toBe(1);
  } finally { controller.abort(); await fixture.close(); }
});
