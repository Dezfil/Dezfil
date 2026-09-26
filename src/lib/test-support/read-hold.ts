import { expect } from "vitest";

/** A missed interception must fail before the competing mutation starts. */
export function readHold(label: string) {
  let engaged = false;
  let release!: () => void;
  let signal!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  return {
    async engage() {
      engaged = true;
      signal();
      await gate;
    },
    async beforeMutation() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          reached,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label}: hold did not engage`)), 3000);
          }),
        ]);
        expect(engaged, `${label}: hold engaged before competing mutation`).toBe(true);
        console.info(`${label}: HOLD ENGAGED; competing mutation starts next`);
      } finally {
        clearTimeout(timer);
      }
    },
    release,
  };
}
