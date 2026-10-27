import { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { startRenderRelay, type RenderRelay, type RenderRelayOptions } from "./render-relay";
import { RelaySockets, deferred, socksRequest, until } from "./test-support/relay";

// Real listeners: run outside the restricted implementation environment.
const network = new RelaySockets();
const relays: RenderRelay[] = [];
async function start(options: Partial<RenderRelayOptions> = {}) {
  const relay = await startRenderRelay({ deadline: Date.now() + 10_000, requestBoundMs: 1_000, ...options });
  relays.push(relay); return relay;
}
afterEach(async () => { vi.restoreAllMocks(); for (const relay of relays.splice(0)) relay.close(); await network.close(); vi.unstubAllEnvs(); });

it("streams coalesced and fragmented frames with backpressure and no authentication", async () => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "echo.test");
  const target = await network.target(); await network.live(target);
  const resolve = vi.fn(async () => ["127.0.0.1"]);
  // A busy runner can take past the one-second request bound to deliver a
  // frame byte by byte. This case is about streaming; its own case holds the bound.
  const relay = await start({ resolve, requestBoundMs: 10_000 });
  for (const fragmented of [true, false]) {
    const client = await network.client(relay.port);
    const frame = socksRequest("echo.test", target.port);
    if (fragmented) for (const byte of frame) { client.socket.write(Buffer.from([byte])); await new Promise<void>(r => setImmediate(r)); }
    else client.socket.write(frame);
    expect([...(await client.read(12, 10_000))]).toEqual([5, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    client.socket.pause();
    const payload = Buffer.alloc(2 * 1024 * 1024, 173);
    client.socket.write(payload); client.socket.resume();
    expect((await client.read(12 + payload.length, 10_000)).subarray(12)).toEqual(payload);
    client.socket.destroy();
  }
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(target.contacts).toBe(2); expect(relay.refused).toBe(false);
});

it("pins the actual connection to one answer and rechecks each reconnect", async () => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "::1");
  const first = await network.target("::1");
  const privateTarget = await network.target("127.0.0.1", first.port);
  await network.live(first); await network.live(privateTarget);
  const resolve = vi.fn().mockResolvedValueOnce(["::1"]).mockResolvedValue(["127.0.0.1"]);
  const relay = await start({ resolve });
  const client = await network.client(relay.port);
  client.socket.write(Buffer.concat([socksRequest("changes.test", first.port), Buffer.from("first")]));
  expect((await client.read(17)).subarray(12).toString()).toBe("first");
  expect(resolve).toHaveBeenCalledTimes(1); expect(first.contacts).toBe(1); expect(privateTarget.contacts).toBe(0);
  client.socket.destroy();
  const next = await network.client(relay.port); next.socket.write(socksRequest("changes.test", first.port));
  expect((await next.read(12))[3]).toBe(2);
  expect(resolve).toHaveBeenCalledTimes(2); expect(privateTarget.contacts).toBe(0); expect(relay.refused).toBe(true);
});

it.each(["ipv4", "ipv6", "domain"] as const)("checks a local client's %s literal before any upstream contact", async type => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
  const target = await network.target(type === "ipv6" ? "::1" : "127.0.0.1"); await network.live(target);
  const resolve = vi.fn(async () => ["203.0.113.7"]);
  const relay = await start({ resolve }); const client = await network.client(relay.port);
  client.socket.write(socksRequest(target.host, target.port, type));
  expect((await client.read(12))[3]).toBe(2);
  expect(target.contacts).toBe(0); expect(resolve).not.toHaveBeenCalled(); expect(relay.refused).toBe(true);
});

it("answers a zone-scoped IPv6 CONNECT with an admission denial", async () => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
  const resolve = vi.fn(async () => ["203.0.113.7"]);
  const relay = await start({ resolve });
  const client = await network.client(relay.port);
  client.socket.write(socksRequest("fe80::1%eth0", 443));
  expect((await client.read(12))[3]).toBe(2);
  expect(relay.refused).toBe(true);
  expect(resolve).not.toHaveBeenCalled();
});

it("refuses a mixed answer without contacting even its admitted first address", async () => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "::1");
  const target = await network.target("::1"); await network.live(target);
  const relay = await start({ resolve: async () => ["::1", "127.0.0.1"] });
  const client = await network.client(relay.port); client.socket.write(socksRequest("mixed.test", target.port));
  expect((await client.read(12))[3]).toBe(2); expect(target.contacts).toBe(0);
});

it.each([["hostname", "trusted.test"], ["IP", "127.0.0.1"], ["CIDR", "127.0.0.0/8"]])("a local client retains the %s exception and cannot contact an unlisted target", async (_kind, allowlist) => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", allowlist);
  const target = await network.target(); const denied = await network.target("::1");
  await network.live(target); await network.live(denied);
  const relay = await start({ resolve: async host => host === "trusted.test" ? ["127.0.0.1"] : ["::1"] });
  const permitted = await network.client(relay.port); permitted.socket.write(socksRequest("trusted.test", target.port));
  expect((await permitted.read(12))[3]).toBe(0); expect(target.contacts).toBe(1);
  const refused = await network.client(relay.port); refused.socket.write(socksRequest("unlisted.test", denied.port));
  expect((await refused.read(12))[3]).toBe(2); expect(denied.contacts).toBe(0);
});

it("falls back to a reachable admitted address without another resolution", async () => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "fallback.test");
  const target = await network.target(); await network.live(target);
  // The first address has no listener at this port; the second is live.
  const resolve = vi.fn(async () => ["::1", "127.0.0.1"]);
  const relay = await start({ resolve }); const client = await network.client(relay.port);
  client.socket.write(Buffer.concat([socksRequest("fallback.test", target.port), Buffer.from("fallback")]));
  expect((await client.read(20)).subarray(12).toString()).toBe("fallback");
  expect(resolve).toHaveBeenCalledTimes(1); expect(target.contacts).toBe(1); expect(relay.refused).toBe(false);
});

it.each(["dns", "transport"])("a %s failure is not a policy refusal", async mode => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "dead.test");
  const target = await network.target();
  const relay = await start({ resolve: async () => { if (mode === "dns") throw Error("NXDOMAIN"); return ["::1"]; } });
  const client = await network.client(relay.port); client.socket.write(socksRequest("dead.test", target.port));
  expect((await client.read(12))[3]).toBe(4); expect(relay.refused).toBe(false); expect(target.contacts).toBe(0);
});

it.each(["http", "command", "incomplete", "length"])("drops %s framing without an upstream socket", async mode => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  const target = await network.target(); await network.live(target);
  const resolve = vi.fn(async () => ["127.0.0.1"]);
  const relay = await start({ resolve, requestBoundMs: 80 }); const client = await network.client(relay.port);
  const frame = socksRequest("127.0.0.1", target.port);
  if (mode === "command") frame[4] = 3;
  client.socket.write(mode === "http" ? Buffer.from("GET / HTTP/1.1\r\n\r\n") : mode === "incomplete" ? frame.subarray(0, 8)
    : mode === "length" ? Buffer.from([5, 255, ...Buffer.alloc(256 * 1024, 2)]) : frame);
  await until(() => client.closed);
  expect(target.contacts).toBe(0); expect(resolve).not.toHaveBeenCalled(); expect(relay.refused).toBe(false);
});

it("revokes late DNS, destroys open tunnels and stops accepting before teardown", async () => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "held.test,live.test");
  const target = await network.target(); await network.live(target);
  const pending = deferred<string[]>(), resolving = deferred<void>();
  const deadline = Date.now() + 10_000;
  // Observe real connects: an immediately destroyed dial may never be accepted.
  const dial = vi.spyOn(Socket.prototype, "connect");
  const relay = await start({ deadline, requestBoundMs: 10_000,
    resolve: async host => { if (host === "live.test") return ["127.0.0.1"]; resolving.resolve(); return pending.promise; } });
  const open = await network.client(relay.port); open.socket.write(socksRequest("live.test", target.port)); await open.read(12);
  expect(dial).toHaveBeenCalledWith({ host: "127.0.0.1", port: target.port });
  expect(target.contacts).toBe(1);
  const held = await network.client(relay.port);
  held.socket.write(Buffer.concat([socksRequest("held.test", target.port), Buffer.from("late payload")])); await resolving.promise;
  relay.close();
  await until(() => open.closed && held.closed && target.active.size === 0);
  await network.assertClosed(relay.port);
  // Release DNS only after closure. Exclude fixture dials and the live tunnel.
  dial.mockClear(); target.reset(); pending.resolve(["127.0.0.1"]);
  await new Promise(r => setTimeout(r, 50));
  // An expired request must not mask the removed close guards in the seed.
  expect(Date.now()).toBeLessThan(deadline);
  expect({ dials: dial.mock.calls.length, contacts: target.contacts, bytes: target.bytes },
    "late DNS must not dial or reach the target after relay close").toEqual({ dials: 0, contacts: 0, bytes: 0 });
});

it("two relays own independent listeners and connections", async () => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "echo.test");
  const target = await network.target();
  const a = await start({ resolve: async () => ["127.0.0.1"] }); const b = await start({ resolve: async () => ["127.0.0.1"] });
  expect(a.port).not.toBe(b.port);
  const one = await network.client(a.port), two = await network.client(b.port);
  one.socket.write(socksRequest("echo.test", target.port)); two.socket.write(socksRequest("echo.test", target.port));
  await one.read(12); await two.read(12); a.close(); await until(() => one.closed);
  two.socket.write("still alive"); expect((await two.read(23)).subarray(12).toString()).toBe("still alive");
  expect(b.refused).toBe(false); await network.assertClosed(a.port);
});

it("abandons open tunnels and incomplete handshakes but accepts another host", async () => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "echo.test,other.test");
  const target = await network.target();
  const resolve = vi.fn(async () => ["127.0.0.1"]);
  const relay = await start({ resolve });
  const open = await network.client(relay.port);
  open.socket.write(Buffer.concat([socksRequest("echo.test", target.port), Buffer.from("before")]));
  expect((await open.read(18)).subarray(12).toString()).toBe("before");
  const incomplete = await network.client(relay.port);
  incomplete.socket.write(Buffer.from([5, 1, 0]));
  await incomplete.read(2);

  relay.abandon(["echo.test"]);
  await until(() => open.closed && incomplete.closed && target.active.size === 0);
  const next = await network.client(relay.port);
  next.socket.write(Buffer.concat([socksRequest("other.test", target.port), Buffer.from("after")]));
  expect((await next.read(17)).subarray(12).toString()).toBe("after");
  expect(target.contacts).toBe(2);
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(relay.refused).toBe(false);
});

it("an abandoned admission cannot dial late and still records a policy refusal", async () => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
  const pending = deferred<string[]>(), resolving = deferred<void>();
  const target = await network.target();
  const relay = await start({ resolve: async () => { resolving.resolve(); return pending.promise; } });
  const client = await network.client(relay.port);
  client.socket.write(socksRequest("held.test", target.port));
  await resolving.promise;
  relay.abandon(["held.test"]);
  await until(() => client.closed);
  pending.resolve(["127.0.0.1"]);
  await relay.settleAdmissions();
  expect(target.contacts).toBe(0);
  expect(relay.refused).toBe(true);
});

it.each([
  ["ECHO.TEST", "echo.test"],
  ["echo.test", "EcHo.TeSt"],
])("refuses re-dials to abandoned %s as %s before admission without affecting another render", async (abandonedHost, retriedHost) => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "echo.test,other.test");
  const target = await network.target();
  const resolve = vi.fn(async () => ["127.0.0.1"]);
  const relay = await start({ resolve });
  const original = await network.client(relay.port);
  original.socket.write(socksRequest("echo.test", target.port));
  expect((await original.read(12))[3]).toBe(0);
  relay.abandon([abandonedHost]);
  await until(() => original.closed && target.active.size === 0);
  target.reset(); resolve.mockClear();

  const retry = await network.client(relay.port);
  retry.socket.write(socksRequest(retriedHost, target.port));
  expect((await retry.read(12))[3]).toBe(4);
  expect(resolve).not.toHaveBeenCalled();
  expect(target.contacts).toBe(0);
  expect(relay.refused).toBe(false);

  const other = await network.client(relay.port);
  other.socket.write(Buffer.concat([socksRequest("other.test", target.port), Buffer.from("other")]));
  expect((await other.read(17)).subarray(12).toString()).toBe("other");
  expect(resolve).toHaveBeenCalledExactlyOnceWith("other.test");
  expect(target.contacts).toBe(1);

  const fresh = await start({ resolve });
  const nextRender = await network.client(fresh.port);
  nextRender.socket.write(Buffer.concat([socksRequest("echo.test", target.port), Buffer.from("fresh")]));
  expect((await nextRender.read(17)).subarray(12).toString()).toBe("fresh");
  expect(target.contacts).toBe(2);
  expect(fresh.refused).toBe(false);
});

it.each([
  { remembered: "::1", retried: "::1", frame: "ipv6" },
  { remembered: "0:0:0:0:0:0:0:1", retried: "::1", frame: "domain" },
  { remembered: "[::1]", retried: "0:0:0:0:0:0:0:1", frame: "domain" },
] as const)("refuses the $frame form of abandoned IPv6 $remembered while another address dials", async ({ remembered, retried, frame }) => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "::1,127.0.0.1");
  const target = await network.target("::1");
  const other = await network.target("127.0.0.1");
  await network.live(target);
  const resolve = vi.fn(async () => ["::1"]);
  const relay = await start({ resolve });
  relay.abandon([remembered]);

  const retry = await network.client(relay.port);
  retry.socket.write(socksRequest(retried, target.port, frame));
  expect((await retry.read(12))[3]).toBe(4);
  expect(target.contacts).toBe(0);
  expect(resolve).not.toHaveBeenCalled();
  expect(relay.refused).toBe(false);

  const next = await network.client(relay.port);
  next.socket.write(Buffer.concat([socksRequest(other.host, other.port, "ipv4"), Buffer.from("other")]));
  expect((await next.read(17)).subarray(12).toString()).toBe("other");
  expect(other.contacts).toBe(1);
});
