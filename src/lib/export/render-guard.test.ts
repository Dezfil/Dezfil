import { describe, it, expect, afterEach } from "vitest";
import { admitRenderRequest } from "./render-guard";

const APP = "http://127.0.0.1:3000";
const resolving =
  (map: Record<string, string[]>) =>
  async (host: string): Promise<string[]> => {
    if (host in map) return map[host];
    throw new Error(`unexpected lookup: ${host}`);
  };

afterEach(() => {
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
});

describe("render request admission", () => {
  it("the app's own origin passes without resolution", async () => {
    expect(
      await admitRenderRequest(`${APP}/render/abc`, APP, resolving({})),
    ).toBe("allow");
    expect(
      await admitRenderRequest(`${APP}/api/maps/x/layers`, APP, resolving({})),
    ).toBe("allow");
  });

  it("data and blob stay local by construction", async () => {
    expect(
      await admitRenderRequest("data:image/png;base64,AA==", APP, resolving({})),
    ).toBe("allow");
    expect(
      await admitRenderRequest(`blob:${APP}/x`, APP, resolving({})),
    ).toBe("allow");
  });

  it("public hosts pass; private, loopback and metadata targets are denied", async () => {
    const resolve = resolving({
      "tiles.example": ["203.0.113.7"],
      "internal.example": ["10.1.2.3"],
      "sneaky.example": ["203.0.113.7", "169.254.169.254"],
    });
    expect(
      await admitRenderRequest("https://tiles.example/s.json", APP, resolve),
    ).toBe("allow");
    expect(
      await admitRenderRequest("https://internal.example/s.json", APP, resolve),
    ).toBe("deny");
    // One private address among many public ones still denies — a
    // multi-answer record must not smuggle a private hop through.
    expect(
      await admitRenderRequest("https://sneaky.example/t/1.pbf", APP, resolve),
    ).toBe("deny");
    expect(
      await admitRenderRequest("http://127.0.0.1:9000/s.json", APP, resolving({})),
    ).toBe("deny");
    expect(
      await admitRenderRequest("http://169.254.169.254/latest", APP, resolving({})),
    ).toBe("deny");
  });

  it("the allowlist names exceptions, exactly as the egress policy reads it", async () => {
    process.env.DEZFIL_EGRESS_ALLOWLIST = "tiles.internal";
    expect(
      await admitRenderRequest(
        "https://tiles.internal/s.json",
        APP,
        resolving({ "tiles.internal": ["10.0.0.5"] }),
      ),
    ).toBe("allow");
  });

  it("a dead hostname is unresolvable — an ordinary failure, not a policy refusal", async () => {
    // NXDOMAIN must let the page reach its dead-style
    // state and bake that wording into the image; only genuine policy
    // denials block the export. Never continued either — an attacker's
    // DNS could answer NXDOMAIN to Node and a private address to
    // Chromium.
    expect(
      await admitRenderRequest("https://gone.example/s.json", APP, async () => {
        throw new Error("NXDOMAIN");
      }),
    ).toBe("unresolvable");
    expect(
      await admitRenderRequest(
        "https://empty.example/s.json",
        APP,
        async () => [],
      ),
    ).toBe("unresolvable");
  });

  it("malformed URLs and odd schemes are denied", async () => {
    expect(await admitRenderRequest("not a url", APP, resolving({}))).toBe(
      "deny",
    );
    expect(
      await admitRenderRequest("ftp://x.example/f", APP, resolving({})),
    ).toBe("deny");
  });
});
