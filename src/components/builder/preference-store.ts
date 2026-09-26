/**
 * localStorage-backed per-browser preference store: a snapshot read, a
 * write that notifies same-tab listeners, and a subscribe — the
 * `useSyncExternalStore` contract. Extracted from MapBuilder under the
 * decomposition rule: the assistant rail, developer mode, and the
 * status pill were three identical copies of this shape.
 */
export interface PreferenceStore {
  read(): boolean;
  write(value: boolean): void;
  subscribe(onChange: () => void): () => void;
}

export function createPreferenceStore(key: string): PreferenceStore {
  let listeners: (() => void)[] = [];
  return {
    read(): boolean {
      try {
        return localStorage.getItem(key) === "true";
      } catch {
        return false;
      }
    },
    write(value: boolean) {
      try {
        localStorage.setItem(key, String(value));
      } catch {
        // Storage unavailable — the preference just won't be remembered.
      }
      for (const listener of listeners) listener();
    },
    subscribe(onChange: () => void): () => void {
      listeners.push(onChange);
      return () => {
        listeners = listeners.filter((l) => l !== onChange);
      };
    },
  };
}

/**
 * The same shape, for a value that is not a boolean.
 *
 * The drawer's snap width is a number, and the contract is explicit that it may
 * not be encoded as a pair of booleans and may not open a new persistence
 * mechanism for one value. So the store widens: same key discipline, same
 * failure behaviour when storage is unavailable — the preference simply is not
 * remembered.
 */
export interface ValueStore {
  read(): number | null;
  write(value: number): void;
  subscribe(onChange: () => void): () => void;
}

export function createValueStore(key: string): ValueStore {
  let listeners: (() => void)[] = [];
  return {
    read(): number | null {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return null;
        const value = Number.parseFloat(raw);
        return Number.isFinite(value) && value > 0 ? value : null;
      } catch {
        return null;
      }
    },
    write(value: number) {
      try {
        localStorage.setItem(key, String(value));
      } catch {
        // Storage unavailable — the preference just won't be remembered.
      }
      for (const listener of listeners) listener();
    },
    subscribe(onChange: () => void): () => void {
      listeners.push(onChange);
      return () => {
        listeners = listeners.filter((l) => l !== onChange);
      };
    },
  };
}

/**
 * A string-valued store on the same contract (D2): the exception
 * strip's Ignore persists an observed-state fingerprint per layer, and a
 * boolean cannot say *which* state was ruled fine — a second source
 * refresh must re-arm the strip although "ignored" would still be true.
 */
export interface StringStore {
  read(): string | null;
  write(value: string | null): void;
  subscribe(onChange: () => void): () => void;
}

export function createStringStore(key: string): StringStore {
  let listeners: (() => void)[] = [];
  return {
    read(): string | null {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write(value: string | null) {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        // Storage unavailable — the dismissal just won't be remembered.
      }
      for (const listener of listeners) listener();
    },
    subscribe(onChange: () => void) {
      listeners.push(onChange);
      return () => {
        listeners = listeners.filter((l) => l !== onChange);
      };
    },
  };
}
