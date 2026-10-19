"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  NO_FRESH_PICTURES,
  PICTURE_POLL_MS,
  anyWaiting,
  askedCards,
  currentPictures,
  landPictures,
  withFreshPicture,
  type FreshPictures,
  type PictureCard,
} from "./picture-poll";

const FreshPicturesContext = createContext<FreshPictures>(NO_FRESH_PICTURES);

/**
 * A listing owner's poll for its cards' pictures: while a card it draws
 * waits, it asks `read` again every five seconds, one ask at a time (the
 * next is timed from the last one's answer), and stops when none waits or
 * the owner unmounts. A failed ask keeps what is shown and the next one
 * asks again. The cards are the owner's own, as it holds them; an answer
 * reaches every card picture and picture credit line inside while the
 * owner still holds the card it was asked of, and a card the owner reads
 * anew stands as read, asked again while it waits.
 */
export function PicturePoll({
  cards,
  read,
  children,
}: {
  /** The maps whose pictures the owner draws now, as it holds them. */
  cards: readonly PictureCard[] | null;
  /** One ask of the owner's own listing. */
  read: () => Promise<readonly PictureCard[]>;
  children: ReactNode;
}) {
  const fresh = usePicturePoll(cards, read);
  return <FreshPicturesContext.Provider value={fresh}>{children}</FreshPicturesContext.Provider>;
}

function usePicturePoll(cards: readonly PictureCard[] | null, read: () => Promise<readonly PictureCard[]>): FreshPictures {
  const [fresh, setFresh] = useState<FreshPictures>(NO_FRESH_PICTURES);
  // Counts settled asks; each one times the next.
  const [answered, setAnswered] = useState(0);
  const latest = useRef({ cards, read });
  useEffect(() => {
    latest.current = { cards, read };
  });
  const asking = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = useMemo(() => currentPictures(fresh, cards), [fresh, cards]);
  const waiting = cards !== null && anyWaiting(current, cards);
  useEffect(() => {
    if (!waiting || asking.current) return;
    const timer = setTimeout(() => {
      const asked = askedCards(latest.current.cards ?? []);
      asking.current = true;
      void latest.current
        .read()
        .then(
          (answer) => {
            if (mounted.current) setFresh((held) => landPictures(held, asked, answer));
          },
          () => {
            // What is shown stays; the next ask tries again.
          },
        )
        .finally(() => {
          asking.current = false;
          if (mounted.current) setAnswered((n) => n + 1);
        });
    }, PICTURE_POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, answered]);
  return current;
}

/** The card with the freshest picture its page has asked for. */
export function useFreshPicture<T extends PictureCard>(card: T): T {
  return withFreshPicture(useContext(FreshPicturesContext), card);
}

/** Every card with the freshest picture its page has asked for. */
export function useFreshPictures<T extends PictureCard>(cards: readonly T[]): readonly T[] {
  const fresh = useContext(FreshPicturesContext);
  return useMemo(() => (fresh === NO_FRESH_PICTURES ? cards : cards.map((card) => withFreshPicture(fresh, card))), [fresh, cards]);
}
