/** Test-only hook scheduler. Executes production hook bodies and their effects;
 * it does not render DOM or claim browser evidence. */
type Slot = { value?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
let active: HookHarness<unknown> | null = null;
const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
export class HookHarness<T> {
  slots: Slot[] = [];
  cursor = 0;
  effects: (() => void)[] = [];
  changed = false;
  mounted = true;
  value!: T;
  updates = 0;
  constructor(private read: () => T) { this.render(); }
  render() {
    do {
      this.changed = false;
      this.cursor = 0;
      active = this as HookHarness<unknown>;
      this.value = this.read();
      active = null;
      for (const effect of this.effects.splice(0)) effect();
    } while (this.changed);
    return this.value;
  }
  unmount() { this.mounted = false; for (const s of this.slots) s.cleanup?.(); }
  remount() { this.mounted = true; for (const s of this.slots) if ('cleanup' in s) s.deps = undefined; this.render(); }
}
function seat() {
  if (!active) throw new Error('Hook outside the test scheduler');
  const h = active; const i = h.cursor++;
  return { h, s: h.slots[i] ?? (h.slots[i] = {}) };
}
export const hookReact = {
  useState<T>(initial: T | (() => T)) {
    const { h, s } = seat();
    if (!('value' in s)) s.value = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [s.value, (value: T | ((v: T) => T)) => {
      const next = typeof value === 'function' ? (value as (v: T) => T)(s.value as T) : value;
      if (!Object.is(s.value, next)) { s.value = next; h.changed = true; h.updates++; }
    }] as const;
  },
  useRef<T>(value: T) { const { s } = seat(); return (s.value ??= { current: value }) as { current: T }; },
  useMemo<T>(make: () => T, deps: unknown[]) { const { s } = seat(); if (!same(s.deps, deps)) { s.value = make(); s.deps = deps; } return s.value as T; },
  useCallback<T>(fn: T, deps: unknown[]) { return hookReact.useMemo(() => fn, deps); },
  useEffect(effect: () => void | (() => void), deps?: unknown[]) {
    const { h, s } = seat();
    if (!same(s.deps, deps)) { s.deps = deps; h.effects.push(() => { s.cleanup?.(); s.cleanup = effect(); }); }
  },
  useSyncExternalStore(subscribe: (fn: () => void) => () => void, get: () => unknown) {
    const [, set] = hookReact.useState(0);
    hookReact.useEffect(() => subscribe(() => set((n) => n + 1)), [subscribe]);
    return get();
  },
};
