// Serves the test-only loopback basemap on the port given, until stopped:
//   node scripts/loopback-basemap-serve.mjs 3582
// It prints the light style's address once it answers.
import assert from "node:assert/strict";
import { startLoopbackBasemap } from "./loopback-basemap.mjs";

const port = Number(process.argv[2]);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535 && port !== 3000, "Supply a separate loopback fixture port");
const fixture = await startLoopbackBasemap(port);
console.log(fixture.styleUrl);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void fixture.close(); });
