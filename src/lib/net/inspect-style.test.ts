import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { ApiError } from "@/lib/api/errors";
import {
  inspectStyle,
  normalizeAttribution,
} from "./inspect-style";
import type { RemoteResponse } from "./remote-fetch";

const respond = (
  body: string | Buffer,
  statusCode = 200,
): (() => Promise<RemoteResponse>) => {
  return async () => ({
    statusCode,
    headers: {},
    body: Readable.from([Buffer.from(body)]) as IncomingMessage,
    finalUrl: "https://styles.example/style.json",
  });
};

// A genuinely valid style — the inspector now runs the spec's own
// validator, which rejects sources without tiles/url
// and layers without types, exactly as the renderer would.
const STYLE = JSON.stringify({
  version: 8,
  name: "Company dark",
  sources: {
    base: {
      type: "vector",
      tiles: ["https://tiles.x.test/{z}/{x}/{y}.pbf"],
      attribution: '© <a href="https://osm.org/copyright">OpenStreetMap</a>',
    },
    hills: {
      type: "raster",
      tiles: ["https://tiles.x.test/hills/{z}/{x}/{y}.png"],
    },
  },
  layers: [
    { id: "bg", type: "background" },
    { id: "water", type: "fill", source: "base", "source-layer": "water" },
    { id: "roads", type: "line", source: "base", "source-layer": "transportation" },
  ],
});

describe("style inspection", () => {
  it("answers valid with name, counts, and normalized attribution", async () => {
    const result = await inspectStyle("https://x.test/s.json", respond(STYLE));
    expect(result).toEqual({
      verdict: "valid",
      name: "Company dark",
      layerCount: 3,
      sourceCount: 2,
      attribution: [
        { label: "© OpenStreetMap", href: "https://osm.org/copyright" },
      ],
    });
  });

  it("rejects a malformed URL and a non-http scheme without fetching", async () => {
    let fetched = false;
    const spy = async () => {
      fetched = true;
      throw new Error("unreachable");
    };
    expect((await inspectStyle("not a url", spy)).verdict).toBe("not_style");
    expect((await inspectStyle("ftp://x.test/s.json", spy)).verdict).toBe(
      "not_style",
    );
    expect(fetched).toBe(false);
  });

  it("answers not_style for non-JSON and for JSON that lacks the style shape", async () => {
    expect(
      (await inspectStyle("https://x.test/s", respond("<html>"))).verdict,
    ).toBe("not_style");
    const noLayers = JSON.stringify({ version: 8, sources: {} });
    expect(
      (await inspectStyle("https://x.test/s", respond(noLayers))).verdict,
    ).toBe("not_style");
    const arrayRoot = JSON.stringify([1, 2, 3]);
    expect(
      (await inspectStyle("https://x.test/s", respond(arrayRoot))).verdict,
    ).toBe("not_style");
    // everything MapLibre's own validator
    // rejects is not a style — wrong versions, null layers, typeless
    // layers, sources with no tiles/url.
    for (const invalid of [
      { version: 7, sources: {}, layers: [] },
      { version: 8, sources: {}, layers: [null] },
      { version: 8, sources: {}, layers: [{ id: "x" }] },
      { version: 8, sources: { broken: {} }, layers: [] },
    ]) {
      expect(
        (
          await inspectStyle(
            "https://x.test/s",
            respond(JSON.stringify(invalid)),
          )
        ).verdict,
      ).toBe("not_style");
    }
  });

  it("answers unreachable for HTTP errors and network failures", async () => {
    const http404 = await inspectStyle("https://x.test/s", respond("no", 404));
    expect(http404).toEqual({ verdict: "unreachable", detail: "HTTP 404." });
    const down = await inspectStyle("https://x.test/s", async () => {
      throw new ApiError("remote_fetch_failed", "Could not reach it.", 502);
    });
    expect(down.verdict).toBe("unreachable");
    const slow = await inspectStyle("https://x.test/s", async () => {
      throw new ApiError("remote_timeout", "The style fetch timed out.", 504);
    });
    expect(slow.verdict).toBe("unreachable");
  });

  it("answers blocked when the egress policy denies the host", async () => {
    const result = await inspectStyle("https://internal.test/s", async () => {
      throw new ApiError("egress_blocked", "Blocked.", 403);
    });
    expect(result.verdict).toBe("blocked");
    expect(String((result as { detail: string }).detail)).toContain(
      "DEZFIL_EGRESS_ALLOWLIST",
    );
  });

  it("caps the body and calls the overrun not a style", async () => {
    const huge = Buffer.alloc(2 * 1024 * 1024 + 1, 0x7b);
    const result = await inspectStyle("https://x.test/s", respond(huge));
    expect(result).toEqual({ verdict: "not_style", detail: "The style is larger than 2 MB." });
  });
});

describe("attribution normalization", () => {
  it("strips markup, keeps one https link, decodes entities", () => {
    expect(
      normalizeAttribution([
        '&copy; <a href="https://esri.com">Esri</a> &amp; partners',
      ]),
    ).toEqual([{ label: "© Esri & partners", href: "https://esri.com" }]);
  });

  it("drops non-strings, empties, and duplicates; bounds count and length", () => {
    const lines = normalizeAttribution([
      42,
      "   ",
      "Same",
      "Same",
      "x".repeat(500),
      "a",
      "b",
      "c",
    ]);
    expect(lines.length).toBe(4);
    expect(lines[1].label.length).toBeLessThanOrEqual(160);
    // A javascript: link never survives; the label does.
    expect(
      normalizeAttribution(['<a href="javascript:alert(1)">Click</a>']),
    ).toEqual([{ label: "Click" }]);
  });
});

it("passes advisory cancellation to the exchange while retaining the eight-second budget", async () => {
  const controller = new AbortController();
  let seen: Parameters<typeof import("./remote-fetch").openRemote>[1];
  const open = async (_url: string, options: typeof seen) => {
    seen = options;
    return respond(STYLE)();
  };
  await Reflect.apply(inspectStyle, null, ["https://x.test/s", open, controller.signal]);
  expect(seen?.signal).toBe(controller.signal);
  expect(seen?.timeoutMs).toBe(8_000);
});
