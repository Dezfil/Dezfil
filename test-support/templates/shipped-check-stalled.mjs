import * as shipped from "../../src/lib/templates/shipped.ts";
import { currentTrustedOperation } from "../../src/lib/trusted-operation.ts";

export * from "../../src/lib/templates/shipped.ts";

/** The real check, entered only after the calling operation's deadline. */
export async function checkShippedSet(...args) {
  const operation = currentTrustedOperation();
  const left = operation.deadline - performance.now();
  process.stderr.write(`Shipped-set check entered with ${Math.round(left)} ms left.\n`);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, left) + 500));
  return shipped.checkShippedSet(...args);
}
