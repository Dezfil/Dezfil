/** Sets a decoded value as the object's own key. Plain assignment would hand
 * a column or field named `__proto__` to the prototype setter, which drops
 * the value (or swaps the object's prototype) instead of keeping it. */
export function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
