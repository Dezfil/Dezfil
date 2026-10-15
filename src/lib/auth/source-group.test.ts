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

it("refuses what is not an address, as verified provenance does", () => {
  expect(() => accountingSource("not an address")).toThrow("Invalid ingress address");
});
