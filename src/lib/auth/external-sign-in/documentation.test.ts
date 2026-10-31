import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parseExternalSignIn } from "./config";
import { makeStart } from "./start";
import { verifyTicket } from "./ticket";
const guide = readFileSync("docs/self-host/sign-in-service.md", "utf8");
let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(process.env.DEZFIL_DATA_DIR!, "door-guide-")); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function source(title: string) {
  const block = guide.split('```js title="' + title + '"\n')[1]?.split("\n```")[0];
  expect(block, title).toBeDefined(); return block!;
}
it("runs the documented key generator and ticket signer against the real ticket verifier", () => {
  writeFileSync(path.join(directory, "make-door-key.mjs"), source("make-door-key.mjs"));
  const publicKey = execFileSync(process.execPath, ["make-door-key.mjs"], { cwd: directory, encoding: "utf8" }).trim();
  expect(Buffer.from(publicKey, "base64url")).toHaveLength(32);
  expect(statSync(path.join(directory, "door-private.pem")).mode & 0o777).toBe(0o600);
  writeFileSync(path.join(directory, "door-ticket.mjs"), source("door-ticket.mjs"));
  const start = makeStart(), config = { audience: "maps-production", instanceUrl: "https://maps.example.com", doorGeneration: 3 };
  const person = { id: "stable-owner", email: "owner@example.com", name: "Map owner" };
  const harness = `import { readFileSync } from "node:fs";
import { arrivalUrl } from "./door-ticket.mjs";
console.log(arrivalUrl({ ...${JSON.stringify(config)}, privateKey: readFileSync("door-private.pem") }, ${JSON.stringify(person)}, ${JSON.stringify(start.value)}));`;
  writeFileSync(path.join(directory, "issue.mjs"), harness);
  const url = new URL(execFileSync(process.execPath, ["issue.mjs"], { cwd: directory, encoding: "utf8" }).trim());
  expect(url.origin + url.pathname).toBe("https://maps.example.com/arrive"); expect(url.search).toBe("");
  const ticket = new URLSearchParams(url.hash.slice(1)).get("ticket")!;
  const mode = parseExternalSignIn({ DEZFIL_EXTERNAL_SIGN_IN_KEYS: publicKey, DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE: config.audience, DEZFIL_EXTERNAL_SIGN_IN_URL: "https://door.example/sign-in" });
  expect(verifyTicket(ticket, start.cookie, 3, Date.now(), mode)).toMatchObject({ sub: person.id, email: person.email, name: person.name, start: start.value, door_generation: 3 });
  expect(() => verifyTicket(ticket, makeStart().cookie, 3, Date.now(), mode)).toThrow();
  expect(() => verifyTicket(ticket, start.cookie, 4, Date.now(), mode)).toThrow();
});
