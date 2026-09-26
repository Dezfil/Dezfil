/** The OSM query disclosure's three-state model: form-driven
 * (custom null, drawer closed), open draft (drawer open, edits live in
 * the draft only), and armed custom (drawer closed, custom non-null —
 * the query preview and import actually use). Only acceptance arms the
 * custom query; cancel discards the draft and returns to whatever was
 * in force before the drawer opened; regenerate is the explicit road
 * back to the form. Pure, so the transitions are testable apart from
 * the pane. The detach semantics underneath are's, unchanged. */
export interface OsmDisclosure {
  open: boolean;
  /** The drawer's working text — meaningful only while open. */
  draft: string;
  /** The accepted custom query; null means form-driven. */
  custom: string | null;
}

export const FORM_DRIVEN: OsmDisclosure = {
  open: false,
  draft: "",
  custom: null,
};

/** Open the drawer seeded with what is currently in force. */
export function openDisclosure(
  d: OsmDisclosure,
  generated: string | null,
): OsmDisclosure {
  return { ...d, open: true, draft: d.custom ?? generated ?? "" };
}

/** Keep editing — the draft never leaks into the active query. */
export function editDraft(d: OsmDisclosure, draft: string): OsmDisclosure {
  return { ...d, draft };
}

/** Accept: the draft becomes the armed custom query. */
export function acceptDisclosure(d: OsmDisclosure): OsmDisclosure {
  return { open: false, draft: "", custom: d.draft };
}

/** Cancel: discard the draft; what was in force stays in force. */
export function cancelDisclosure(d: OsmDisclosure): OsmDisclosure {
  return { open: false, draft: "", custom: d.custom };
}

/** Back to the form — discards the custom query entirely. */
export function regenerateDisclosure(): OsmDisclosure {
  return FORM_DRIVEN;
}

/** The form is out of the loop while the drawer is open or a custom
 * query is armed (the detached state). */
export function formDisabled(d: OsmDisclosure): boolean {
  return d.open || d.custom !== null;
}

/** Run/Import wait while the drawer is open — only acceptance may
 * change what they send. */
export function actionsDisabled(d: OsmDisclosure): boolean {
  return d.open;
}
