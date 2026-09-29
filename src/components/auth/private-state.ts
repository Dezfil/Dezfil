/** Private browser memory has a terminal fence until the next document loads.
 * Stores register their own reset without pulling the builder into the shell. */
const resets = new Set<() => void>();
let closed = false;
export const ACCOUNT_STORAGE_KEY = "dezfil:account";
const TAB_ACCOUNT_KEY = "dezfil:tab-account";
export const ACCOUNT_CHANGED_EVENT = "dezfil:account-changed";

export function onPrivateReset(reset: () => void): void { resets.add(reset); }
export function privateStateOpen(): boolean { return !closed; }

function storage(kind: "localStorage" | "sessionStorage"): Storage | undefined {
  try { return globalThis[kind]; } catch { return undefined; }
}
function read(store: Storage | undefined, key: string): string | null {
  try { return store?.getItem(key) ?? null; } catch { return null; }
}
function write(store: Storage | undefined, key: string, value: string): void {
  try { store?.setItem(key, value); } catch { /* Memory-only tabs still work. */ }
}
function clear(store: Storage | undefined): void {
  try {
    if (!store) return;
    const keys = Array.from({ length: store.length }, (_, index) => store.key(index));
    for (const key of keys) if (key?.startsWith("dezfil:") || key?.startsWith("dezfil.")) store.removeItem(key);
  } catch { /* A refused store cannot disclose a remembered draft. */ }
}

export function closePrivateState(): void {
  closed = true;
  for (const reset of resets) reset();
}

/** Called only after the server identity and a fresh session read agree.
 * Legacy unlabelled drafts cannot be attributed and are discarded once. */
export function openPrivateState(accountId: string): void {
  const local = storage("localStorage"), session = storage("sessionStorage");
  if (read(local, ACCOUNT_STORAGE_KEY) !== accountId || read(session, TAB_ACCOUNT_KEY) !== accountId) {
    closePrivateState();
    if (read(local, ACCOUNT_STORAGE_KEY) !== accountId) clear(local);
    if (read(session, TAB_ACCOUNT_KEY) !== accountId) clear(session);
  }
  write(local, ACCOUNT_STORAGE_KEY, accountId);
  write(session, TAB_ACCOUNT_KEY, accountId);
  closed = false;
}

/** Entry and sign-out use this after the server accepts the change. Other
 * tabs also close immediately; focus/session checks cover unavailable storage. */
export function accountChanged(): void {
  closePrivateState();
  clear(storage("localStorage")); clear(storage("sessionStorage"));
  write(storage("localStorage"), ACCOUNT_STORAGE_KEY, "");
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT));
  if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(ACCOUNT_CHANGED_EVENT);
    channel.postMessage("changed"); channel.close();
  }
}
