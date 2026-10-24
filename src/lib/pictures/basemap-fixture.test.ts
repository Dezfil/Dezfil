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

it("the held-tile fixture answers its tiles after the wait it names, or never, and records each request's times", async () => {
  const fixture = await pictureBasemap();
  const controller = new AbortController();
  try {
    const style = await (await fetch(`${fixture.origin}/hold.json?ms=300&w=13.4&s=0&e=13.41&n=0.01`)).json();
    expect(style.sources.held).toEqual({ type: "raster", tileSize: 512, bounds: [13.4, 0, 13.41, 0.01], tiles: [`${fixture.origin}/hold/300/{z}/{x}/{y}.png`] });
    const asked = Date.now();
    const tile = await fetch(`${fixture.origin}/hold/300/10/550/512.png`);
    expect(tile.headers.get("content-type")).toBe("image/png");
    expect(Date.now() - asked).toBeGreaterThanOrEqual(290);
    const never = fetch(`${fixture.origin}/hold/never/10/550/512.png`, { signal: controller.signal }).catch(() => undefined);
    await expect.poll(() => fixture.requests().filter(r => r.path.startsWith("/hold/never/")).length).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort(); await never;
    await expect.poll(() => fixture.requests().find(r => r.path.startsWith("/hold/never/"))?.closed).toBeDefined();
    const [styleRead, heldRead, neverRead] = fixture.requests();
    expect(styleRead.answered).toBeDefined();
    expect(heldRead.answered! - heldRead.started).toBeGreaterThanOrEqual(290);
    expect(heldRead.closed).toBeUndefined();
    expect(neverRead.answered).toBeUndefined();
  } finally { controller.abort(); await fixture.close(); }
});
