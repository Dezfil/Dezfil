// Prove the baked extension bundle is complete:
// LOAD every supported extension from the bundle — no INSTALL, no
// network. CI runs this inside the built runtime image with
// --network=none, so a missing extension fails the pipeline instead of
// failing an air-gapped operator at import time.
//
// Usage: node check-duckdb-extensions-offline.mjs [extension-dir]
//   extension-dir defaults to $DUCKDB_EXTENSION_DIR.
import { createRequire } from "node:module";
import { EXTENSIONS } from "./duckdb-extensions.mjs";

async function loadDuckDb() {
  try {
    return await import("@duckdb/node-api");
  } catch {
    // Inside the runtime image the script is bind-mounted outside /app;
    // resolve the engine from the app's own dependency tree.
    const require = createRequire("/app/package.json");
    return require("@duckdb/node-api");
  }
}

const dir = process.argv[2] || process.env.DUCKDB_EXTENSION_DIR;
if (!dir) {
  console.error(
    "usage: check-duckdb-extensions-offline.mjs <extension-dir> (or set DUCKDB_EXTENSION_DIR)",
  );
  process.exit(2);
}

const { DuckDBInstance } = await loadDuckDb();
const instance = await DuckDBInstance.create(":memory:", {
  extension_directory: dir,
  // The check proves the bundle, not DuckDB's ability to fetch: nothing
  // may be installed or auto-loaded on the way.
  autoinstall_known_extensions: "false",
  autoload_known_extensions: "false",
});
const conn = await instance.connect();

const missing = [];
for (const { name } of EXTENSIONS) {
  try {
    await conn.run(`LOAD ${name}`);
    console.log(`ok: ${name}`);
  } catch (error) {
    missing.push(name);
    console.error(
      `MISSING: ${name} did not load from ${dir} — ${
        error instanceof Error ? error.message.split("\n")[0] : error
      }`,
    );
  }
}
conn.disconnectSync();

if (missing.length > 0) {
  console.error(
    `FAIL — ${missing.length} extension(s) not loadable offline: ${missing.join(", ")}`,
  );
  process.exit(1);
}
console.log(`PASS — all ${EXTENSIONS.length} extensions load offline.`);
