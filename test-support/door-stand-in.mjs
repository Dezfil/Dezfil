// A stand-in for a sign-in service, for tests and browser smokes only. It serves
// a small page where the tester says who is signing in, signs a ticket with the
// test key below and returns the browser to the instance, as a real service does.
//
// The key is derived from a sentence in this file, so anyone can sign with it. An
// instance that trusts its public key lets anyone in: never configure it anywhere
// but a scratch instance.
//
//   node test-support/door-stand-in.mjs --public-key
//   DOOR_INSTANCE_URL=http://localhost:3310 node test-support/door-stand-in.mjs
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const seed = createHash("sha256").update("dezfil door stand-in test key").digest();
const testKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });

/** What DEZFIL_EXTERNAL_SIGN_IN_KEYS takes to trust this stand-in. */
export const PUBLIC_KEY = createPublicKey(testKey).export({ format: "jwk" }).x;
export const AUDIENCE = "door-stand-in";
export const OWNER = { id: "owner-id", email: "owner@example.test", name: "Owner" };

/** The tickets a tester can ask for: a good one, and three the instance must refuse. */
const VARIANTS = { valid: "A valid ticket", "other-audience": "For another instance", expired: "Expired", "other-key": "Signed by another key" };

const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A compact ticket for one person and one start, in the door guide's format. */
export function signTicket({ start, person, audience = AUDIENCE, doorGeneration = 0, variant = "valid", now = Date.now() }) {
  const seconds = Math.floor(now / 1000), age = variant === "expired" ? 600 : 0;
  const claims = {
    aud: variant === "other-audience" ? `${audience}-other` : audience,
    sub: person.id, email: person.email, email_verified: true, ...(person.name ? { name: person.name } : {}),
    iat: seconds - age, exp: seconds - age + 300, jti: randomUUID(), start, door_generation: doorGeneration,
  };
  const key = variant === "other-key" ? generateKeyPairSync("ed25519").privateKey : testKey;
  const input = `${encode({ alg: "EdDSA" })}.${encode(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
}

const escapeHtml = text => String(text).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

function page(start, person, doorGeneration) {
  const field = (label, name, value) => `<p><label>${label} <input name="${name}" value="${escapeHtml(value)}"></label></p>`;
  const options = Object.entries(VARIANTS).map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Door stand-in</title>
<h1>Door stand-in</h1>
<form method="get" action="/return">
<input type="hidden" name="start" value="${escapeHtml(start)}">
${field("Identity id", "id", person.id)}${field("Verified email", "email", person.email)}${field("Name", "name", person.name ?? "")}${field("Door generation", "door_generation", doorGeneration)}
<p><label>Ticket <select name="ticket">${options}</select></label></p>
<button type="submit">Return to the instance</button>
</form></html>`;
}

/** Serves the page at /sign-in and the return at /return. Answers the listening server. */
export function startDoor({ instanceUrl, port = 0, host = "127.0.0.1", audience = AUDIENCE, person = OWNER, doorGeneration = 0 }) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://door.invalid"), start = url.searchParams.get("start");
    if (!start || !["/sign-in", "/return"].includes(url.pathname)) { response.writeHead(404).end("Start at the instance."); return; }
    if (url.pathname === "/sign-in") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page(start, person, doorGeneration));
      return;
    }
    const value = name => url.searchParams.get(name) ?? "";
    const ticket = signTicket({ start, audience, doorGeneration: Number(value("door_generation")), variant: value("ticket") || "valid",
      person: { id: value("id"), email: value("email"), name: value("name") } });
    const destination = new URL("/arrive", instanceUrl);
    destination.hash = new URLSearchParams({ ticket }).toString();
    response.writeHead(303, { location: destination.href, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
  });
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve(server)); });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--public-key")) console.log(PUBLIC_KEY);
  else {
    const instanceUrl = process.env.DOOR_INSTANCE_URL;
    if (!instanceUrl) { console.error("Set DOOR_INSTANCE_URL to the instance's address."); process.exit(1); }
    const port = Number(process.env.DOOR_PORT ?? 3899);
    await startDoor({ instanceUrl, port, audience: process.env.DOOR_AUDIENCE ?? AUDIENCE });
    console.log(`Door stand-in at http://127.0.0.1:${port}/sign-in, returning to ${instanceUrl}`);
  }
}
