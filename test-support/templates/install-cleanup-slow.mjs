import * as retained from "../../src/lib/query/retained.ts";

export * from "../../src/lib/query/retained.ts";

/** The real engine reset, finished only well after the shortened allowance. */
export async function purgeQueryStores(...args) {
  await retained.purgeQueryStores(...args);
  await new Promise(resolve => setTimeout(resolve, 1500));
  process.stderr.write("Engine reset finished.\n");
}
