import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { ArrivalScreen } from "./ArrivalScreen";

/**
 * The page the sign-in service returns to: the ticket leaves the address and
 * goes once to the arrival operation; acceptance lands where a sign-in lands;
 * a browser holding a session is told which account and keeps it; every other
 * refusal shows the server's words with the way to start again. The entry read
 * and the operations are fakes.
 */

vi.mock("@/components/theme", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ThemeToggle: () => null,
}));

const ACCOUNT = { id: "ada", name: "Ada Okafor", email: "ada@example.test" };
let answer: () => Response;
let posted: { url: string; body: unknown }[];
let replaced: string[];
let addresses: string[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size; },
  };
}

beforeEach(() => {
  posted = []; replaced = []; addresses = [];
  answer = () => Response.json({ account: ACCOUNT });
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === "/api/auth/entry") return Response.json({ instanceName: "Atlas", landingPage: "maps" });
    posted.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/auth/sign-out") return Response.json({ signedOut: true });
    return answer();
  }));
  host = installDomHost();
  Object.assign(host.window, {
    location: { origin: "https://dezfil.example", pathname: "/arrive", hash: "#ticket=head.body.signature", replace: (href: string) => { replaced.push(href); } },
    history: { state: null, replaceState: (_state: unknown, _title: string, url: string) => { addresses.push(url); } },
  });
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function open() {
  await act(async () => root.render(<ArrivalScreen />));
  await settle();
}
const button = (label: string) => container.querySelectorAll("button").find(element => element.textContent === label);
const startForm = () => container.querySelector('form[action="/api/auth/external/start"]');
const arrivals = () => posted.filter(post => post.url === "/api/auth/external/arrive");

describe("the arrival", () => {
  it("takes the ticket out of the address, hands it to the operation once and lands on the stored page", async () => {
    await open();
    expect(addresses).toEqual(["/arrive"]);
    expect(arrivals()).toEqual([{ url: "/api/auth/external/arrive", body: { ticket: "head.body.signature" } }]);
    expect(replaced).toEqual(["https://dezfil.example/maps"]);
  });

  it("spends the ticket once when the screen's effect runs twice", async () => {
    const { StrictMode } = await import("react");
    await act(async () => root.render(<StrictMode><ArrivalScreen /></StrictMode>));
    await settle();
    expect(arrivals()).toHaveLength(1);
    expect(replaced).toHaveLength(1);
  });

  it("says it is signing in while the operation answers", async () => {
    let finish: (value: Response) => void = () => {};
    answer = () => new Promise<Response>(resolve => { finish = resolve; }) as unknown as Response;
    await open();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Signing you in…");
    await act(async () => finish(Response.json({ account: ACCOUNT })));
    await settle();
    expect(replaced).toEqual(["https://dezfil.example/maps"]);
  });
});

describe("in a browser that already holds a session", () => {
  beforeEach(() => {
    answer = () => Response.json({ error: { code: "already_signed_in", message: "Sign out of the current account before signing in through the sign-in service.", account: ACCOUNT } }, { status: 409 });
  });

  it("names the account, lands nowhere and signs nothing out on its own", async () => {
    await open();
    expect(container.querySelector("h1")?.textContent).toBe("You are already signed in");
    expect(container.textContent).toContain("This browser is signed in as Ada Okafor (ada@example.test).");
    expect(replaced).toEqual([]);
    expect(posted.map(post => post.url)).toEqual(["/api/auth/external/arrive"]);
    expect(startForm()).toBeNull();
  });

  it("signs out only when asked, then goes to the sign-in page", async () => {
    await open();
    await act(async () => { button("Sign out")!.click(); });
    await settle();
    expect(posted.map(post => post.url)).toEqual(["/api/auth/external/arrive", "/api/auth/sign-out"]);
    expect(replaced).toEqual(["https://dezfil.example/sign-in"]);
  });

  it("goes on signed in when the person stays, with no sign-out sent", async () => {
    await open();
    await act(async () => { button("Stay signed in")!.click(); });
    expect(replaced).toEqual(["https://dezfil.example/maps"]);
    expect(posted.map(post => post.url)).toEqual(["/api/auth/external/arrive"]);
  });
});

describe("a refusal", () => {
  it.each([
    ["invalid_ticket", "This sign-in ticket is invalid or expired. Start sign-in again.", 401],
    ["no_account", "There is no account for ada@example.test on this instance. Ask its admin for an invitation.", 403],
    ["account_deactivated", "This account is deactivated. Contact an admin.", 403],
    ["email_taken", "An account already uses this email address.", 409],
  ])("%s shows the server's words and starts again by the form, landing nowhere", async (code, message, status) => {
    answer = () => Response.json({ error: { code, message } }, { status });
    await open();
    expect(container.querySelector("h1")?.textContent).toBe("Sign-in did not finish");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(startForm()?.getAttribute("method")).toBe("post");
    expect(startForm()?.querySelector("button")?.textContent).toBe("Start again");
    expect(replaced).toEqual([]);
  });

  it("names the time to try again when too many arrivals failed", async () => {
    const retryAt = "2026-10-31T12:00:00.000Z";
    answer = () => Response.json({ error: { code: "rate_limited", message: "Too many attempts.", retryAt } }, { status: 429 });
    await open();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(`Too many sign-in attempts. Try again at ${new Date(retryAt).toLocaleTimeString()}.`);
  });

  it("asks nothing of the server without a ticket, and offers to start again", async () => {
    (host.window as unknown as { location: { hash: string } }).location.hash = "";
    await open();
    expect(arrivals()).toEqual([]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("This sign-in link is unavailable. Start sign-in again.");
    expect(startForm()).not.toBeNull();
  });

  it("says the instance could not be reached when the operation cannot answer", async () => {
    answer = () => { throw new TypeError("Failed to fetch"); };
    await open();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("This instance could not be reached. Start sign-in again.");
  });

  it("still arrives, landing Home, when the entry read fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/auth/entry" ? Response.json({ error: { code: "internal", message: "No." } }, { status: 500 }) : answer()));
    await open();
    expect(replaced).toEqual(["https://dezfil.example/"]);
  });
});
