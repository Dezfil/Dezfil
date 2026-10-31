import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIENCE, OWNER, PUBLIC_KEY, signTicket, startDoor } from "../../../../test-support/door-stand-in.mjs";
import { makeStart } from "./start";
import { verifyTicket } from "./ticket";

/**
 * The stand-in the browser smoke signs in through: what it signs is what the
 * real verifier takes, and its refused kinds are refused for real.
 */

const MODE = Symbol.for("dezfil.external-sign-in");
let server: Server | null;
beforeEach(() => {
  server = null;
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_KEYS", PUBLIC_KEY);
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE", AUDIENCE);
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_URL", "http://127.0.0.1:3899/sign-in");
  Reflect.deleteProperty(process, MODE);
});
afterEach(async () => {
  if (server) await new Promise(resolve => server!.close(resolve));
  vi.unstubAllEnvs();
  Reflect.deleteProperty(process, MODE);
});

const door = async () => {
  const listening: Server = await startDoor({ instanceUrl: "http://localhost:3310" });
  server = listening;
  const address = listening.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
};

describe("its tickets", () => {
  it("pass the real verifier with the test key", () => {
    const start = makeStart();
    expect(verifyTicket(signTicket({ start: start.value, person: OWNER }), start.cookie, 0)).toMatchObject({ sub: OWNER.id, email: OWNER.email, aud: AUDIENCE });
  });

  it.each(["other-audience", "expired", "other-key"])("are refused by the real verifier as %s", variant => {
    const start = makeStart();
    expect(() => verifyTicket(signTicket({ start: start.value, person: OWNER, variant }), start.cookie, 0)).toThrow(/invalid or expired/);
  });

  it("carry the door generation asked for", () => {
    const start = makeStart();
    expect(verifyTicket(signTicket({ start: start.value, person: OWNER, doorGeneration: 4 }), start.cookie, 4).door_generation).toBe(4);
    expect(() => verifyTicket(signTicket({ start: start.value, person: OWNER, doorGeneration: 3 }), start.cookie, 4)).toThrow(/invalid or expired/);
  });
});

describe("its road", () => {
  it("serves a page for the start, and returns the browser to the arrival page with the ticket in the fragment", async () => {
    const base = await door(), start = makeStart();
    const form = await fetch(`${base}/sign-in?start=${start.value}`);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain(`value="${start.value}"`);
    const query = new URLSearchParams({ start: start.value, id: "ada-id", email: "ada@example.test", name: "Ada", door_generation: "0", ticket: "valid" });
    const back = await fetch(`${base}/return?${query}`, { redirect: "manual" });
    expect(back.status).toBe(303);
    const location = new URL(back.headers.get("location")!);
    expect(location.origin + location.pathname + location.search).toBe("http://localhost:3310/arrive");
    const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket")!;
    expect(verifyTicket(ticket, start.cookie, 0)).toMatchObject({ sub: "ada-id", email: "ada@example.test", name: "Ada" });
  });

  it("escapes what it echoes, and asks for a start", async () => {
    const base = await door();
    expect(await (await fetch(`${base}/sign-in?start=${encodeURIComponent('"><script>')}`)).text()).not.toContain("<script>");
    expect((await fetch(`${base}/sign-in`)).status).toBe(404);
  });
});
