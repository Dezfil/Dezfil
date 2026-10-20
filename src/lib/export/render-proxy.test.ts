import { expect, it } from "vitest";
import { renderProxyFlags } from "./render-proxy";
const bypass = (flags: string[]) => flags.filter(flag => flag.startsWith("--proxy-bypass-list="));
it.each([
  ["http://127.0.0.1:3216", "--proxy-bypass-list=<-loopback>;http://127.0.0.1:3216"],
  ["https://[::1]", "--proxy-bypass-list=<-loopback>;https://[::1]:443"],
  ["http://127.0.0.1", "--proxy-bypass-list=<-loopback>;http://127.0.0.1:80"],
])("the exception is exact for %s", (origin, rule) => {
  expect(bypass(renderProxyFlags(origin, 41733))).toEqual([rule]);
  expect(renderProxyFlags(origin, 41733)).toContain("--proxy-server=socks5://127.0.0.1:41733");
});
it.each([
  ["http://127.0.0.1:3216", "--proxy-bypass-list=<-loopback>;http://127.0.0.1:3216;ws://127.0.0.1:3216"],
  ["https://[::1]", "--proxy-bypass-list=<-loopback>;https://[::1]:443;wss://[::1]:443"],
  ["http://127.0.0.1", "--proxy-bypass-list=<-loopback>;http://127.0.0.1:80;ws://127.0.0.1:80"],
])("under the development server the reload socket of %s bypasses at the same host and port, and nothing else", (origin, rule) => {
  const flags = renderProxyFlags(origin, 41733, { developmentReload: true });
  expect(bypass(flags)).toEqual([rule]);
  expect(flags).toContain("--proxy-server=socks5://127.0.0.1:41733");
  // The relay stays the road for every other address, loopback included.
  expect(flags.some(flag => /direct|pac-url|\*/.test(flag))).toBe(false);
});
it("adds no reload socket exception unless asked", () => {
  for (const options of [undefined, {}, { developmentReload: false }]) {
    expect(bypass(renderProxyFlags("http://127.0.0.1:3216", 41733, options))).toEqual(["--proxy-bypass-list=<-loopback>;http://127.0.0.1:3216"]);
  }
});
it("does not turn a named app origin into a hostname-wide exception", () => {
  expect(() => renderProxyFlags("http://localhost:3216", 41733)).toThrow();
  expect(() => renderProxyFlags("http://localhost:3216", 41733, { developmentReload: true })).toThrow();
});
