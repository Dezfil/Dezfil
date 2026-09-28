// Native dispatch proof used against both the checkout and packaged preload.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { pathToFileURL } from "node:url";
import path from "node:path";

const { requireIngress } = await import(pathToFileURL(path.resolve("src/lib/auth/ingress.mjs")));
const missing = process.argv.includes("--expect-missing");
const server = createServer((incoming, response) => {
  try {
    const view = requireIngress(new Headers(incoming.headers));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(view));
  } catch {
    response.writeHead(503); response.end("{}");
  }
});
await new Promise(resolve => server.listen(0, "::", resolve));
const { port } = server.address();
const forged = {
  "x-forwarded-for": "203.0.113.99", "x-forwarded-host": "forged.example",
  "x-forwarded-proto": "https", "x-forwarded-port": "443",
  forwarded: "for=203.0.113.99;host=forged.example;proto=https",
  "x-dezfil-ingress": "caller-supplied",
};
const read = (host, headers) => new Promise((resolve, reject) => {
  const req = request({ host, port, headers }, response => {
    let body = "";
    response.on("data", chunk => { body += chunk; });
    response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
  });
  req.on("error", reject); req.setTimeout(5000, () => req.destroy(new Error("Socket probe timed out"))); req.end();
});
try {
  const direct = await read("::1", forged);
  if (missing) assert.equal(direct.status, 503);
  else {
    assert.equal(direct.status, 200);
    assert.equal(direct.body.source, "::1");
    assert.equal(direct.body.origin, `http://[::1]:${port}`);
    assert.equal(direct.body.secure, false);
    const proxied = await read("127.0.0.1", forged);
    assert.equal(proxied.status, 200);
    assert.equal(proxied.body.peer, "127.0.0.1");
    assert.equal(proxied.body.source, "203.0.113.99");
    assert.equal(proxied.body.origin, "https://forged.example");
    assert.equal(proxied.body.secure, true);
    assert.equal((await read("127.0.0.1", { ...forged, "x-forwarded-proto": "file" })).status, 400);
  }
  console.log(missing ? "PASS: missing preload refuses provenance" : "PASS: distinct direct/proxy sockets, canonical source/host/protocol/port");
} finally { await new Promise(resolve => server.close(resolve)); }
