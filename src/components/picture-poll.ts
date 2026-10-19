import type { MapOverview } from "./api";

/**
 * Fresh card pictures for a page whose cards wait for one. A listing owner
 * asks its own listing again, gently, while a card it draws waits; what the
 * answer says of each card's picture is laid over the card the owner still
 * holds, so a new picture shows without a reload and nothing else on the
 * page moves: no card arrives, leaves or reorders between the owner's own
 * reads. An answer is laid over a card only while the card is as it was
 * when the answer was asked for; once the owner reads its listing again,
 * that newer read stands.
 */

/** How long a page with waiting cards leaves between its asks. */
export const PICTURE_POLL_MS = 5_000;

/** What of a listed map its card picture, and the line crediting the
 * page's pictures, are drawn from. */
export type PictureFacts = Pick<MapOverview, "pictureState" | "pictureVersion" | "hasThumbnail" | "thumbnailBasemap">;

/** A card on the page, as its listing owner holds it. */
export type PictureCard = { id: string } & PictureFacts;

interface FreshPicture {
  /** The card's facts when the answer was asked for. */
  readonly basis: string;
  readonly facts: PictureFacts;
}

/** The answers laid over a page's cards, by map. */
export type FreshPictures = ReadonlyMap<string, FreshPicture>;

export const NO_FRESH_PICTURES: FreshPictures = new Map();

function factsOf(card: PictureFacts): PictureFacts {
  return {
    pictureState: card.pictureState,
    pictureVersion: card.pictureVersion,
    hasThumbnail: card.hasThumbnail,
    thumbnailBasemap: card.thumbnailBasemap ?? null,
  };
}

function basisOf(card: PictureFacts): string {
  return JSON.stringify(factsOf(card));
}

/** The card with the freshest picture facts the page has for it. */
export function withFreshPicture<T extends PictureCard>(fresh: FreshPictures, card: T): T {
  const answer = fresh.get(card.id);
  return answer && answer.basis === basisOf(card) ? { ...card, ...answer.facts } : card;
}

/** Whether a card on the page still waits for its picture. */
export function anyWaiting(fresh: FreshPictures, cards: readonly PictureCard[]): boolean {
  return cards.some((card) => withFreshPicture(fresh, card).pictureState === "waiting");
}

/** Each card's facts as an ask begins: what an answer may be laid over. */
export function askedBases(cards: readonly PictureCard[]): ReadonlyMap<string, string> {
  return new Map(cards.map((card) => [card.id, basisOf(card)]));
}

/** The page's fresh pictures once an answer lands: each asked card's facts
 * as the answer gives them, kept to the card as it was asked; a card the
 * answer no longer lists keeps what it had. Unchanged, the same value. */
export function landPictures(
  fresh: FreshPictures,
  asked: ReadonlyMap<string, string>,
  answer: readonly PictureCard[],
): FreshPictures {
  let next: Map<string, FreshPicture> | null = null;
  for (const listed of answer) {
    const basis = asked.get(listed.id);
    if (basis === undefined) continue;
    const facts = factsOf(listed);
    const prior = fresh.get(listed.id);
    if (prior && prior.basis === basis && basisOf(prior.facts) === basisOf(facts)) continue;
    next ??= new Map(fresh);
    next.set(listed.id, { basis, facts });
  }
  return next ?? fresh;
}

/** One ask of a maps listing for the pictures' facts; a failure throws,
 * and the page keeps what it shows. */
export async function readPictureListing(path: string): Promise<PictureCard[]> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`The listing answered ${response.status}.`);
  return (await response.json()) as PictureCard[];
}
