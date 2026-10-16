import { expect, it } from "vitest";
import { accountingSource } from "./source-group";

it("keeps an IPv4 source, mapped or not, as itself", () => {
  expect(accountingSource("192.0.2.7")).toBe("192.0.2.7");
  expect(accountingSource("192.0.2.7:443")).toBe("192.0.2.7");
  expect(accountingSource("::ffff:192.0.2.7")).toBe("192.0.2.7");
  expect(accountingSource("::ffff:c000:207")).toBe("192.0.2.7");
  expect(accountingSource("192.0.2.8")).not.toBe(accountingSource("192.0.2.7"));
});

it("counts every address of one IPv6 /64 as that /64, whatever its spelling", () => {
  const prefix = "2001:db8:0:1::/64";
  for (const address of ["2001:db8:0:1::1", "2001:db8:0:1:ffff:ffff:ffff:ffff", "2001:0DB8:0000:0001:0:0:0:9",
    "[2001:db8:0:1:a:b:c:d]:8443", "2001:db8:0:1:1::"]) expect(accountingSource(address), address).toBe(prefix);
  expect(accountingSource("2001:db8:0:2::1")).toBe("2001:db8:0:2::/64");
  expect(accountingSource("2001:db8:1:1::1")).toBe("2001:db8:1:1::/64");
  expect(accountingSource("::1")).toBe("::/64");
  expect(accountingSource("fe80::1:2:3:4")).toBe("fe80::/64");
});

it("counts a source behind a NAT64 translator's well-known prefix as the IPv4 client it carries", () => {
  // 64:ff9b::/96 puts the IPv4 client in the last 32 bits, so it counts as
  // that client, as a mapped spelling does.
  for (const address of ["64:ff9b::192.0.2.7", "64:ff9b::c000:207", "[64:ff9b::c000:207]:443", "0064:FF9B:0:0:0:0:C000:0207"]) {
    expect(accountingSource(address), address).toBe("192.0.2.7");
  }
  expect(accountingSource("64:ff9b::192.0.2.8")).toBe("192.0.2.8");
  expect(accountingSource("64:ff9b::1")).toBe("0.0.0.1");
  // Only the /96 carries a client there; the rest of 64:ff9b::/64 is an
  // ordinary /64. The local-use prefix 64:ff9b:1::/48 does not say where
  // its client sits, so it stays grouped by /64.
  expect(accountingSource("64:ff9b::1:c000:207")).toBe("64:ff9b::/64");
  expect(accountingSource("64:ff9b:0:0:1::1")).toBe("64:ff9b::/64");
  expect(accountingSource("64:ff9b:1::192.0.2.7")).toBe("64:ff9b:1::/64");
  expect(accountingSource("64:ff9b:1::192.0.2.8")).toBe("64:ff9b:1::/64");
  expect(accountingSource("64:ff9a::c000:207")).toBe("64:ff9a::/64");
});

it("refuses what is not an address, as verified provenance does", () => {
  expect(() => accountingSource("not an address")).toThrow("Invalid ingress address");
});
