import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import {
  egressBlockedError,
  isAddressAllowed,
  isBlockedIp,
  resolveAllowed,
  validatingLookup,
} from "./egress";

afterEach(() => {
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
});

describe("isBlockedIp", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.255.255.254", true],
    ["10.0.0.5", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["169.254.169.254", true], // cloud metadata
    ["100.64.0.1", true], // carrier-grade NAT
    ["0.0.0.0", true],
    ["224.0.0.1", true],
    ["255.255.255.255", true],
    ["93.184.216.34", false],
    ["8.8.8.8", false],
  ])("classifies IPv4 %s → blocked=%s", (ip, blocked) => {
    expect(isBlockedIp(ip)).toBe(blocked);
  });

  it.each([
    ["::1", true],
    ["::", true],
    ["fe80::1", true],
    ["fc00::1", true],
    ["fd12:3456::1", true],
    ["ff02::1", true],
    ["2606:2800:220:1::248", false],
  ])("classifies IPv6 %s → blocked=%s", (ip, blocked) => {
    expect(isBlockedIp(ip)).toBe(blocked);
  });

  it("unwraps IPv4-mapped and NAT64 forms before classifying", () => {
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedIp("64:ff9b::10.0.0.1")).toBe(true);
    expect(isBlockedIp("64:ff9b::808:808")).toBe(false);
  });

  it("treats unparseable input as blocked", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });
});

describe("allowlist", () => {
  it("admits a blocked address by exact hostname", () => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "nas.local, printer.lan";
    expect(isAddressAllowed("nas.local", "192.168.1.50")).toBe(true);
    expect(isAddressAllowed("NAS.LOCAL", "192.168.1.50")).toBe(true);
    expect(isAddressAllowed("other.local", "192.168.1.50")).toBe(false);
  });

  it("admits a blocked address by IP and by CIDR", () => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "10.1.2.3, 192.168.7.0/24";
    expect(isAddressAllowed("whatever", "10.1.2.3")).toBe(true);
    expect(isAddressAllowed("whatever", "10.1.2.4")).toBe(false);
    expect(isAddressAllowed("whatever", "192.168.7.99")).toBe(true);
    expect(isAddressAllowed("whatever", "192.168.8.1")).toBe(false);
  });

  it("public addresses need no allowlist", () => {
    expect(isAddressAllowed("example.com", "93.184.216.34")).toBe(true);
  });
});

describe("resolveAllowed", () => {
  const fakeLookup = (addresses: { address: string; family: number }[]) =>
    (async () => addresses) as unknown as Parameters<typeof resolveAllowed>[1];

  it("checks IP literals directly, without resolving", async () => {
    await expect(resolveAllowed("169.254.169.254")).rejects.toMatchObject({
      code: "egress_blocked",
    });
    await expect(resolveAllowed("93.184.216.34")).resolves.toEqual([
      "93.184.216.34",
    ]);
  });

  it("filters a mixed answer down to the public addresses", async () => {
    const addresses = await resolveAllowed(
      "example.com",
      fakeLookup([
        { address: "10.0.0.9", family: 4 },
        { address: "93.184.216.34", family: 4 },
      ]),
    );
    expect(addresses).toEqual(["93.184.216.34"]);
  });

  it("rejects uniformly when every address is blocked", async () => {
    const attempt = resolveAllowed(
      "internal.service",
      fakeLookup([{ address: "10.0.0.9", family: 4 }]),
    );
    await expect(attempt).rejects.toMatchObject({
      code: "egress_blocked",
      status: 403,
      message: egressBlockedError().message,
    });
  });

  it("admits a blocked resolution for an allowlisted name", async () => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "internal.service";
    const addresses = await resolveAllowed(
      "internal.service",
      fakeLookup([{ address: "10.0.0.9", family: 4 }]),
    );
    expect(addresses).toEqual(["10.0.0.9"]);
  });
});

describe("validatingLookup", () => {
  it("resolves localhost to a blocked answer and errors uniformly", async () => {
    const lookup = validatingLookup("localhost");
    const result = await new Promise<Error | null>((resolve) => {
      lookup("localhost", { all: false }, (err) => resolve(err));
    });
    expect(result).toBeInstanceOf(ApiError);
    expect((result as ApiError).code).toBe("egress_blocked");
    expect(result?.message).toBe(egressBlockedError().message);
  });

  it("admits localhost when the administrator allowlists it", async () => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "localhost";
    const lookup = validatingLookup("localhost");
    const address = await new Promise<string | undefined>((resolve, reject) => {
      lookup("localhost", { all: false }, (err, addr) =>
        err ? reject(err) : resolve(addr as string),
      );
    });
    expect(["127.0.0.1", "::1"]).toContain(address);
  });
});

for (const arm of ["failure", "answer"] as const) {
  describe(`IPv6 resolver with lookup ${arm}`, () => {
    for (const literal of ["::1", "fd00::1", "2001:4860:4860::8888"]) {
      for (const host of [literal, `[${literal}]`]) {
        it(`${host} never consults lookup`, async () => {
          const lookup = vi.fn(async () => {
            if (arm === "failure") throw new Error("injected lookup failure");
            return [{ address: "2001:4860:4860::8844", family: 6 }];
          });
          let returned: string[] | null = null;
          const error = await resolveAllowed(host, lookup as unknown as Parameters<typeof resolveAllowed>[1])
            .then((addresses) => { returned = addresses; return null; }, (e) => e);
          console.info(JSON.stringify({ arm, host, lookups: lookup.mock.calls, returned, error: error?.code ?? error?.message ?? null }));
          expect.soft(lookup).not.toHaveBeenCalled();
          if (literal === "2001:4860:4860::8888") {
            expect.soft(error).toBeNull();
            expect.soft(returned).toEqual(["2001:4860:4860::8888"]);
          } else {
            expect.soft(returned).toBeNull();
            expect.soft(error).toMatchObject({ code: "egress_blocked", status: 403 });
          }
        });
      }
    }
  });
}


describe("PostGIS literal normalization and administrator exceptions", () => {
  it.each(["::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1"])("blocks both spellings of %s without DNS", async (literal) => {
    const lookup = vi.fn();
    for (const host of [literal, `[${literal}]`]) {
      await expect(resolveAllowed(host, lookup)).rejects.toMatchObject({ status: 403, code: "egress_blocked" });
    }
    expect(lookup).not.toHaveBeenCalled();
  });
  it.each(["::1", "::1/128", "::/64"])("admits both spellings by %s", async (entry) => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = entry;
    const lookup = vi.fn();
    for (const host of ["::1", "[::1]"]) {
      await expect(resolveAllowed(host, lookup)).resolves.toEqual(["::1"]);
    }
    expect(lookup).not.toHaveBeenCalled();
  });
  it("does not treat a bracket-spelled entry as a hostname exception", async () => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "[::1]";
    const lookup = vi.fn();
    for (const host of ["::1", "[::1]"]) {
      await expect(resolveAllowed(host, lookup)).rejects.toMatchObject({ code: "egress_blocked" });
    }
    expect(lookup).not.toHaveBeenCalled();
  });
  it.each(["[db.example.org]", "[not:ipv6]", "[::1", "::1]", "[fe80::1%eth0]", "[::ffff:127.0.0.1%1]"])("retains the lookup path for malformed host %s", async (host) => {
    const lookup = vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    await expect(resolveAllowed(host, lookup)).resolves.toEqual(["8.8.8.8"]);
    expect(lookup).toHaveBeenCalledWith(host, { all: true, verbatim: true });
  });
});
