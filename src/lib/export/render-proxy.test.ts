import { expect, it } from "vitest";
import { renderProxyFlags } from "./render-proxy";
it.each([
  ["http://127.0.0.1:3216", "--proxy-bypass-list=<-loopback>;http://127.0.0.1:3216"],
  ["https://[::1]", "--proxy-bypass-list=<-loopback>;https://[::1]:443"],
  ["http://127.0.0.1", "--proxy-bypass-list=<-loopback>;http://127.0.0.1:80"],
])("the exception is exact for %s", (origin, rule) => {
  expect(renderProxyFlags(origin, 41733)).toContain(rule);
  expect(renderProxyFlags(origin, 41733)).toContain("--proxy-server=socks5://127.0.0.1:41733");
});
it("does not turn a named app origin into a hostname-wide exception", () => {
  expect(() => renderProxyFlags("http://localhost:3216", 41733)).toThrow();
});
