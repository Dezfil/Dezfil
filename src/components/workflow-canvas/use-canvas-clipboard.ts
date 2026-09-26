"use client";

import { useEffect, useRef, type RefObject } from "react";
import {
  readClipboardItem,
  writeClipboardItem,
  type ClipboardItem,
} from "./clipboard-items";
import { pasteChoice } from "./clipboard-choice";
import { controlOwnsKey } from "./key-ownership";

/**
 * Copy and paste on the canvas. The gesture is the canvas's while it
 * has focus and native Copy does not own it: an editable control, an
 * open dialog or a text selection keeps its native meaning. Copy writes
 * the item through the copy event when the browser raises one for the
 * key (no permission, any origin) and through the clipboard API
 * otherwise; a page-local copy is kept beside it, marked with whether
 * the system write succeeded. Paste reads the paste event's text: a
 * recognised item pastes; when the system write had failed, the local
 * copy pastes instead; foreign text does nothing, quietly, and never
 * resurrects an older item. Copying a source invalidates whatever this
 * page copied before.
 */

export type CopyAnswer =
  | { item: ClipboardItem; said: string }
  | { refuse: string }
  | { invalidate: { text: string; said: string } }
  | null;

const NOTHING = "Nothing selected.";
const WITHHELD =
  "The browser withheld the clipboard, so it will not reach another workflow.";

function nativeOwns(target: EventTarget | null): boolean {
  // The shared rule: an editable control, an open dialog. Copy adds the
  // one case that is its own and not the record's, a text selection
  // anywhere on the page.
  if (controlOwnsKey(target)) return true;
  const sel = window.getSelection?.();
  return !!sel && sel.toString().length > 0;
}

export function useCanvasClipboard({
  host,
  copy,
  paste,
  say,
  lockReason,
}: {
  host: RefObject<HTMLElement | null>;
  /** The item for the current selection, a refusal to say, an invalidation (a source), or null for no selection. */
  copy: () => Promise<CopyAnswer>;
  paste: (item: ClipboardItem) => void;
  say: (text: string, tone?: "bad") => void;
  lockReason: string | null;
}) {
  const local = useRef<{
    item: ClipboardItem | null;
    systemWrote: boolean;
    invalidated: boolean;
    lastWritten: string | null;
    /** Every item text this page wrote, newest last (clipboard-choice.ts). */
  }>({
    item: null,
    systemWrote: false,
    invalidated: false,
    lastWritten: null,
  });
  // A copy the key armed, for the copy event that follows it in the same
  // task; when no event comes, the clipboard API writes it.
  const armed = useRef<{
    text: string;
    said: string;
    tombstone: boolean;
  } | null>(null);
  // A copy still being answered (the panel's draft landing first): a paste
  // that arrives meanwhile waits for it and takes what it copied.
  const pendingCopy = useRef<Promise<ClipboardItem | null> | null>(null);
  const latest = useRef({ copy, paste, say, lockReason });
  useEffect(() => {
    latest.current = { copy, paste, say, lockReason };
  });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // The canvas has focus: a tile, a note, the flow area or a control
    // within it holds it. The body does not count.
    const inCanvas = () => {
      const a = document.activeElement;
      return !!a && a !== document.body && el.contains(a);
    };
    const settle = (
      text: string,
      said: string,
      wrote: boolean,
      tombstone: boolean,
    ) => {
      armed.current = null;
      const item = tombstone ? null : readClipboardItem(text);
      // The last item this page wrote: what a tombstone stands over, so a
      // newer item from elsewhere still pastes.
      const lastWritten = tombstone
        ? local.current.lastWritten
        : wrote
          ? text
          : local.current.lastWritten;
      local.current = {
        item,
        systemWrote: wrote,
        invalidated: tombstone && !wrote,
        lastWritten,
      };
      latest.current.say(wrote || tombstone ? said : `${said} ${WITHHELD}`);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key !== "c" && e.key !== "C") return;
      if (nativeOwns(e.target) || !inCanvas()) return;
      e.preventDefault();
      const answered = latest.current.copy().then((answer) => {
        if (answer === null) {
          latest.current.say(NOTHING);
          return null;
        }
        if ("refuse" in answer) {
          latest.current.say(answer.refuse, "bad");
          return null;
        }
        if ("invalidate" in answer) {
          // A source: its name goes on the clipboard as plain text, so an
          // older item stops being pasteable; only when that write fails
          // does the page's tombstone stand over the stale system text.
          armed.current = {
            text: answer.invalidate.text,
            said: answer.invalidate.said,
            tombstone: true,
          };
        } else {
          armed.current = {
            text: writeClipboardItem(answer.item),
            said: answer.said,
            tombstone: false,
          };
        }
        const copied = "item" in answer ? answer.item : null;
        // The copy event, when the browser raises one, takes it; else the API.
        // The item stays armed until the write settles: a paste meanwhile
        // takes it, never the system's older text.
        window.setTimeout(() => {
          const a = armed.current;
          if (!a) return;
          const api = navigator.clipboard?.writeText?.bind(navigator.clipboard);
          if (!api) {
            settle(a.text, a.said, false, a.tombstone);
            return;
          }
          api(a.text).then(
            () => settle(a.text, a.said, true, a.tombstone),
            () => settle(a.text, a.said, false, a.tombstone),
          );
        }, 0);
        return copied;
      });
      pendingCopy.current = answered;
      void answered.finally(() => {
        if (pendingCopy.current === answered) pendingCopy.current = null;
      });
    };
    const onCopy = (e: ClipboardEvent) => {
      const a = armed.current;
      if (!a || !e.clipboardData) return;
      e.clipboardData.setData("text/plain", a.text);
      e.preventDefault();
      settle(a.text, a.said, true, a.tombstone);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (nativeOwns(e.target) || !inCanvas()) return;
      const reason = latest.current.lockReason;
      if (reason) {
        latest.current.say(reason, "bad");
        return;
      }
      // A copy still landing, or armed for its write: the paste takes it.
      if (pendingCopy.current) {
        e.preventDefault();
        void pendingCopy.current.then((item) => {
          if (item) latest.current.paste(item);
        });
        return;
      }
      const a = armed.current;
      // A source's invalidation still landing: nothing pastes.
      if (a?.tombstone) return;
      const text = a ? a.text : (e.clipboardData?.getData("text/plain") ?? "");
      const l = local.current;
      // The tombstone of a source copied here, whose write the browser
      // withheld, stands over the older item this page wrote; a newer item
      // from elsewhere is something else copied, and pastes.
      if (l.invalidated && (text.trim() === "" || text === l.lastWritten))
        return;
      // Readable text governs; the local copy pastes when the event carries
      // no text and the last system write had failed, and when the text is
      // this page's own earlier write that the failed one never replaced
      // (the older item was resurrected) — clipboard-choice.ts.
      const item = pasteChoice(text, l);
      if (!item) return;
      e.preventDefault();
      latest.current.paste(item);
    };
    el.addEventListener("keydown", onKey);
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      el.removeEventListener("keydown", onKey);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, [host]);
}
