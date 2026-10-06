import { afterEach, expect, it, vi } from "vitest";
import { trustedPeers } from "@/lib/auth/ingress.mjs";
import { objectStoreCredentialsEnabled } from "@/lib/ingest/remote";
import { isAllowlistedHost } from "@/lib/net/egress";
import { limits } from "@/lib/limits";
import * as offer from "@/lib/assistant/offer";
import { settingDefinition } from "./catalogue";
import { readDeploymentSetting } from "./deployment-read";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const read = (key: string) => readDeploymentSetting(settingDefinition(key));

it.each([
  [undefined, false], ["", false], ["1", true], ["true", true], ["TRUE", true],
  ["yes", true], ["YES", true], [" true ", false], ["0", false], ["off", false], ["invalid", false],
] as const)("matches object-store credential opt-in for %j", (raw, expected) => {
  vi.stubEnv("DEZFIL_OBJECT_STORE_CREDENTIALS", raw);
  expect(read("objectStoreCredentials").value).toBe(expected);
  expect(read("objectStoreCredentials").value).toBe(objectStoreCredentialsEnabled());
});

it.each([
  [undefined, true], ["", true], ["0", false], ["false", false], ["off", false],
  [" OFF ", false], ["False", false], ["1", true], ["yes", true], ["invalid", true], ["  ", true],
] as const)("matches the automatic-check switch for %j", (raw, expected) => {
  vi.stubEnv("DEZFIL_ASSISTANT_AUTO_CHECK", raw);
  expect(read("assistantAutoCheck").value).toBe(expected);
  expect(read("assistantAutoCheck").value).toBe(limits.assistantAutoCheck);
});

it.each([
  [undefined, "subset", false], ["", "subset", false], ["subset", "subset", false],
  ["full", "full", false], ["FULL", "subset", true], [" full ", "subset", true], ["invalid", "subset", true],
] as const)("matches the assistant offer mode for %j", (raw, expected, invalidOverride) => {
  vi.stubEnv("DEZFIL_ASSISTANT_OFFER", raw);
  expect(read("assistantOffer")).toMatchObject({ value: expected, invalidOverride });
  expect(read("assistantOffer").value).toBe(offer.defaultOfferMode());
});

it("uses the shared offer parser when its default changes", () => {
  vi.stubEnv("DEZFIL_ASSISTANT_OFFER", undefined);
  vi.spyOn(offer, "defaultOfferMode").mockReturnValue("full");
  expect(read("assistantOffer").value).toBe("full");
});

it.each([
  [undefined, []], ["", []], [" , \t\n ", []],
  ["127.0.0.1,10.0.0.0/8", ["127.0.0.1", "10.0.0.0/8"]],
  [" 127.0.0.1\t10.0.0.0/8,\n2001:db8::/32 ,127.0.0.1 ", ["127.0.0.1", "10.0.0.0/8", "2001:db8::/32", "127.0.0.1"]],
] as const)("matches trusted-peer list parsing for %j", (raw, expected) => {
  vi.stubEnv("DEZFIL_TRUSTED_PROXIES", raw);
  const reported = read("trustedProxies").value as string[];
  expect(reported).toEqual(expected);
  const consumer = trustedPeers(raw), projected = trustedPeers(reported.join(","));
  for (const address of ["127.0.0.1", "10.1.2.3", "2001:db8::1", "192.0.2.1"]) {
    expect(projected(address), address).toBe(consumer(address));
  }
});

it.each([
  [undefined, []], ["", []], [" , \t\n ", []],
  [" One.test, two.test,One.test , 10.0.0.0/8 ", ["One.test", "two.test", "One.test", "10.0.0.0/8"]],
  ["one.test two.test,\tthree.test\n", ["one.test two.test", "three.test"]],
] as const)("matches egress allowlist parsing for %j", (raw, expected) => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", raw);
  const reported = read("egressAllowlist").value as string[];
  expect(reported).toEqual(expected);
  for (const host of ["one.test", "TWO.TEST", "one.test two.test", "three.test", "10.0.0.0/8", "absent.test"]) {
    expect(reported.some(entry => entry.toLowerCase() === host.toLowerCase()), host).toBe(isAllowlistedHost(host));
  }
});
