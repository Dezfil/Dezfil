import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createPrivateKey, sign } from "node:crypto";
const root = process.cwd();
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "next/server") return next("next/server.js", context);
  const target = specifier.startsWith("@/") ? pathToFileURL(root + "/src/" + specifier.slice(2)).href : specifier;
  if ((target.startsWith(".") || target.startsWith("file:")) && context.parentURL) {
    const candidate = new URL(target + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return { ...next(candidate.href, context), format: "module-typescript" };
  }
  const result = next(target, context);
  return result.url.endsWith(".ts") ? { ...result, format: "module-typescript" } : result;
} });
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { key, id } = JSON.parse(input);
const { metadataDb, closeMetadataDb } = await import("../src/lib/metadata/db.ts");
const { makeStart, startCookieName } = await import("../src/lib/auth/external-sign-in/start.ts");
const { verifyTicket } = await import("../src/lib/auth/external-sign-in/ticket.ts");
const { arriveExternalSignIn } = await import("../src/lib/auth/external-sign-in/arrival.ts");
const { socketRequest } = await import("../src/lib/assistant/testing/socket-request.ts");
const start = makeStart(), now = Math.floor(Date.now() / 1000);
const claims = { aud: "instance", sub: "owner-id", email: "owner@example.test", email_verified: true,
  iat: now, exp: now + 300, jti: id, start: start.value, door_generation: 0 };
const payload = [{ alg: "EdDSA" }, claims].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
const ticket = `${payload}.${sign(null, Buffer.from(payload), createPrivateKey({ key, format: "jwk" })).toString("base64url")}`;
const checked = verifyTicket(ticket, start.cookie, 0);
const request = socketRequest(new Request("https://instance.test/api/auth/external/arrive", { method: "POST",
  headers: { origin: "https://instance.test", "content-type": "application/json", cookie: `${startCookieName()}=${start.cookie}` }, body: JSON.stringify({ ticket }) }));
const response = await arriveExternalSignIn(request);
const sessions = metadataDb().prepare("SELECT count(*) AS n FROM auth_sessions").get().n;
process.stdout.write(JSON.stringify({ status: response.status, body: await response.json(), sessions, checked: checked.jti === id }));
closeMetadataDb();
