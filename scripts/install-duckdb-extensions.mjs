// Bake DuckDB extensions into the image at build time so runtime needs no
// network (spec: air-gapped instances degrade, they don't break). The list
// lives in duckdb-extensions.mjs — one source for the bake and the offline
// CI check.
// Usage: node scripts/install-duckdb-extensions.mjs <extension-dir>
import { DuckDBInstance } from "@duckdb/node-api";
import { EXTENSIONS } from "./duckdb-extensions.mjs";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: install-duckdb-extensions.mjs <extension-dir>");
  process.exit(1);
}

const instance = await DuckDBInstance.create(":memory:", {
  extension_directory: dir,
});
const conn = await instance.connect();
for (const { name, repository } of EXTENSIONS) {
  await conn.run(
    repository ? `INSTALL ${name} FROM ${repository}` : `INSTALL ${name}`,
  );
  await conn.run(`LOAD ${name}`);
}
conn.disconnectSync();
console.log(
  `${EXTENSIONS.map((e) => e.name).join(" + ")} extensions installed into ${dir}`,
);
