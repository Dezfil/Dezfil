import { describe, expect, it } from "vitest";
import {
  NO_FRESH_PICTURES,
  anyWaiting,
  askedBases,
  landPictures,
  withFreshPicture,
  type PictureCard,
} from "./picture-poll";

/**
 * What a page asks for while its cards wait, and how an answer meets the
 * cards: an answer is laid over a card only while the card is as it was
 * when the answer was asked for, so the owner's own newer read always
 * stands; a card the answer no longer lists keeps what it had; and the
 * page waits exactly while a card it draws, freshest picture laid over,
 * still waits.
 */

const card = (id: string, picture: Partial<PictureCard> = {}): PictureCard & { name: string } => ({
  id, name: `Map ${id}`, pictureState: "waiting", pictureVersion: null, hasThumbnail: false, thumbnailBasemap: null, ...picture,
});
const landed = { pictureState: "current", pictureVersion: "server-1", hasThumbnail: true } as const;

describe("fresh pictures over a page's cards", () => {
  it("lays an answer over the card it was asked for, keeping everything else the owner holds", () => {
    const shown = [card("a"), card("b", { pictureState: "current", pictureVersion: "server-7", hasThumbnail: true })];
    const fresh = landPictures(NO_FRESH_PICTURES, askedBases(shown), [card("a", landed), shown[1]]);
    expect(withFreshPicture(fresh, shown[0])).toEqual({ ...shown[0], ...landed });
    expect(withFreshPicture(fresh, shown[0]).name).toBe("Map a");
    expect(withFreshPicture(fresh, shown[1])).toEqual(shown[1]);
  });

  it("lets the owner's own newer read stand over an answer asked before it", () => {
    const asked = card("a");
    const fresh = landPictures(NO_FRESH_PICTURES, askedBases([asked]), [card("a", landed)]);
    const reread = card("a", { pictureState: "current", pictureVersion: "server-2", hasThumbnail: true });
    expect(withFreshPicture(fresh, reread)).toBe(reread);
  });

  it("ignores what the answer says of cards it was not asked for, and keeps a card the answer no longer lists", () => {
    const shown = [card("a")];
    const once = landPictures(NO_FRESH_PICTURES, askedBases(shown), [card("a", landed), card("z", landed)]);
    expect(once.has("z")).toBe(false);
    const twice = landPictures(once, askedBases(shown), []);
    expect(twice).toBe(once);
    expect(withFreshPicture(twice, shown[0]).pictureVersion).toBe("server-1");
  });

  it("answers the same value when an answer changes nothing", () => {
    const shown = [card("a")];
    const fresh = landPictures(NO_FRESH_PICTURES, askedBases(shown), [card("a", landed)]);
    expect(landPictures(fresh, askedBases(shown), [card("a", landed)])).toBe(fresh);
  });

  it("carries the credited basemap with the picture", () => {
    const drawn = { url: "https://style.test/a.json", kind: "vector" as const, custom: false, attribution: [{ label: "© Test" }] };
    const shown = [card("a")];
    const fresh = landPictures(NO_FRESH_PICTURES, askedBases(shown), [card("a", { ...landed, thumbnailBasemap: drawn })]);
    expect(withFreshPicture(fresh, shown[0]).thumbnailBasemap).toEqual(drawn);
  });
});

describe("whether a page waits", () => {
  it("waits while a card it draws waits, freshest picture laid over, and for nothing else", () => {
    const shown = [card("a"), card("b", { pictureState: "failed" })];
    expect(anyWaiting(NO_FRESH_PICTURES, shown)).toBe(true);
    expect(anyWaiting(landPictures(NO_FRESH_PICTURES, askedBases(shown), [card("a", landed)]), shown)).toBe(false);
    for (const pictureState of ["current", "failed", "unsupported", "unavailable"] as const) {
      expect(anyWaiting(NO_FRESH_PICTURES, [card("c", { pictureState })]), pictureState).toBe(false);
    }
    expect(anyWaiting(NO_FRESH_PICTURES, [])).toBe(false);
  });
});
