/**
 * The General tab's rows, under the labels the tab shows: the Instance
 * card's name, then the Sign-in card's message, lost-password contact and
 * landing page, each by the setting it draws. The cards, the search and
 * the documentation's settings tables read the words from here.
 */

export interface GeneralRow {
  readonly key: "instanceName" | "signInMessage" | "lostPasswordContact" | "landingPage";
  /** The row's address inside the tab. */
  readonly id: string;
  readonly label: string;
}

export interface GeneralCard {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly GeneralRow[];
}

export const INSTANCE_CARD = {
  id: "card-instance", title: "Instance", rows: [
    { key: "instanceName", id: "set-instance-name", label: "Instance name" },
  ],
} as const satisfies GeneralCard;

export const SIGN_IN_CARD = {
  id: "card-sign-in", title: "Sign-in", rows: [
    { key: "signInMessage", id: "set-sign-in-message", label: "Message" },
    { key: "lostPasswordContact", id: "set-lost-password-contact", label: "Lost password contact" },
    { key: "landingPage", id: "set-landing-page", label: "Landing page" },
  ],
} as const satisfies GeneralCard;

/** The tab's cards in the order it draws them. */
export const GENERAL_CARDS: readonly GeneralCard[] = [INSTANCE_CARD, SIGN_IN_CARD];

/** A General row by the setting it draws. */
export function generalRow(key: GeneralRow["key"]): GeneralRow {
  const row = GENERAL_CARDS.flatMap(card => card.rows).find(entry => entry.key === key);
  if (!row) throw new Error(`The General tab draws no row for ${key}`);
  return row;
}
