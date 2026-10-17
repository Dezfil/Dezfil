// Preloaded into the picture script's server, and only there: it answers
// nothing and changes nothing. It writes one line for each request the
// process opens through Node's HTTP engines (http and https) or fetch, as
// JSON with the engine, method, host and path, to the file the script names
// in DEZFIL_DOCS_REQUEST_LOG. Headers and bodies are never written.
//
// The file is created when the module loads, so a file that exists and is
// empty at the end of a run means the server opened no request, not that
// the observer was missing. The product's preload chain carries every
// --import in NODE_OPTIONS into the server's forks, so each of them loads it
// too. The query engine's own remote reads do not pass through these engines
// and are outside its sight.
import { subscribe } from "node:diagnostics_channel";
import { appendFileSync } from "node:fs";

const file = process.env.DEZFIL_DOCS_REQUEST_LOG;
if (!file) throw new Error("The request observer needs DEZFIL_DOCS_REQUEST_LOG to name its file.");
appendFileSync(file, "");

const record = (row) => appendFileSync(file, `${JSON.stringify({ ...row, pid: process.pid })}\n`);

// http.request, https.request and everything built on them.
subscribe("http.client.request.start", ({ request }) => {
  record({ engine: "http", method: request.method, host: String(request.getHeader("host") ?? request.host), path: request.path });
});

// fetch, and undici used directly: both publish on this channel.
subscribe("undici:request:create", ({ request }) => {
  let host = String(request.origin ?? "");
  try { host = new URL(host).host; } catch { /* kept as given */ }
  record({ engine: "fetch", method: request.method, host, path: request.path });
});
