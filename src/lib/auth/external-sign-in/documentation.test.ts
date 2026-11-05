import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parseExternalSignIn } from "./config";
import { makeStart } from "./start";
import { verifyTicket } from "./ticket";
import { externalFixture } from "../../../../test-support/external-sign-in";
import { arriveExternalSignIn } from "./arrival";
import { readGenerations } from "@/lib/metadata/auth-generations";
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

it("recovers with the documented environment and a replacement key, then accepts the documented signer's ticket", async () => {
  const page = readFileSync("docs/self-host/configuration/external-sign-in.md", "utf8");
  const block = page.split("## Recover from a leaked door key")[1]?.split('```yaml title="compose.yaml"\n')[1]?.split("\n```")[0];
  expect(block).toBeDefined();
  const environment = Object.fromEntries([...block!.matchAll(/^\s+(DEZFIL_[A-Z_]+): "([^"]+)"/gm)].map(match => [match[1], match[2]]));
  expect(Object.keys(environment).sort()).toEqual(["DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR", "DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET", "DEZFIL_EXTERNAL_SIGN_IN_KEYS"]);
  writeFileSync(path.join(directory, "make-door-key.mjs"), source("make-door-key.mjs"));
  environment.DEZFIL_EXTERNAL_SIGN_IN_KEYS = execFileSync(process.execPath, ["make-door-key.mjs"], { cwd: directory, encoding: "utf8" }).trim();
  writeFileSync(path.join(directory, "door-ticket.mjs"), source("door-ticket.mjs"));
  const f = externalFixture();
  try {
    expect((await arriveExternalSignIn(f.request(f.ticket({ door_generation: Number.MAX_SAFE_INTEGER })))).status).toBe(200);
    f.restart(); expect(f.start(environment)).toBe(true);
    const generation = Number(environment.DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET);
    expect(readGenerations(f.db)).toEqual({ sign_out_generation: 1, door_generation: generation });
    const presentation = f.ticket();
    const config = { audience: "instance", instanceUrl: "https://instance.test", doorGeneration: generation };
    const harness = `import { readFileSync } from "node:fs";
import { arrivalUrl } from "./door-ticket.mjs";
console.log(arrivalUrl({ ...${JSON.stringify(config)}, privateKey: readFileSync("door-private.pem") },
  { id: "owner-id", email: "owner@example.test", name: "Owner" }, ${JSON.stringify(presentation.claims.start)}));`;
    writeFileSync(path.join(directory, "recover.mjs"), harness);
    const url = new URL(execFileSync(process.execPath, ["recover.mjs"], { cwd: directory, encoding: "utf8" }).trim());
    const encoded = new URLSearchParams(url.hash.slice(1)).get("ticket")!;
    expect((await arriveExternalSignIn(f.request({ ...presentation, encoded }))).status).toBe(200);
    const before = f.snapshot();
    expect((await arriveExternalSignIn(f.request(f.ticket({ door_generation: Number.MAX_SAFE_INTEGER })))).status).toBe(401);
    expect(f.snapshot()).toEqual(before);
    f.restart(); expect(f.start(environment)).toBe(false); expect(f.snapshot()).toEqual(before);
  } finally { f.close(); }
});
