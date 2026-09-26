import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { resolveCustomBasemapWrite, CUSTOM_NAME_MAX } from "./basemap-custom";
import type { inspectStyle, StyleInspection } from "@/lib/net/inspect-style";

const inspecting =
  (result: StyleInspection): typeof inspectStyle =>
  async () =>
    result;

const VALID: StyleInspection = {
  verdict: "valid",
  name: "Style name",
  layerCount: 3,
  sourceCount: 1,
  attribution: [{ label: "© Somebody", href: "https://somebody.test" }],
};

const message = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "";
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("invalid_request");
    return (error as ApiError).message;
  }
};

describe("custom basemap write semantics", () => {
  it("null clears; a valid style saves with its attribution snapshot", async () => {
    expect(await resolveCustomBasemapWrite(null, inspecting(VALID))).toBeNull();
    expect(
      await resolveCustomBasemapWrite(
        { url: "https://x.test/s.json", name: "Company dark" },
        inspecting(VALID),
      ),
    ).toEqual({
      url: "https://x.test/s.json",
      name: "Company dark",
      attribution: [{ label: "© Somebody", href: "https://somebody.test" }],
    });
  });

  it("a valid style with no source attribution credits the hostname", async () => {
    const result = await resolveCustomBasemapWrite(
      { url: "https://styles.example/s.json" },
      inspecting({ ...VALID, attribution: [] }),
    );
    expect(result?.attribution).toEqual([{ label: "styles.example" }]);
    expect(result?.name).toBeNull();
  });

  it("not-a-style never saves, forced or not", async () => {
    const stated = { url: "https://x.test/page.html", force: true };
    expect(
      await message(
        resolveCustomBasemapWrite(
          stated,
          inspecting({ verdict: "not_style", detail: "The response is not JSON." }),
        ),
      ),
    ).toContain("not a MapLibre style");
  });

  it("unreachable blocks without force and saves the hostname credit with it", async () => {
    const unreachable: StyleInspection = {
      verdict: "unreachable",
      detail: "HTTP 404.",
    };
    const text = await message(
      resolveCustomBasemapWrite(
        { url: "https://gone.test/s.json" },
        inspecting(unreachable),
      ),
    );
    expect(text).toContain("force: true");
    const forced = await resolveCustomBasemapWrite(
      { url: "https://gone.test/s.json", force: true },
      inspecting(unreachable),
    );
    expect(forced).toEqual({
      url: "https://gone.test/s.json",
      name: null,
      attribution: [{ label: "gone.test" }],
    });
  });

  it("blocked behaves as unreachable does: warn, then force", async () => {
    const blocked: StyleInspection = { verdict: "blocked", detail: "Denied." };
    await expect(
      resolveCustomBasemapWrite({ url: "https://internal.test/s" }, inspecting(blocked)),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const forced = await resolveCustomBasemapWrite(
      { url: "https://internal.test/s", force: true },
      inspecting(blocked),
    );
    expect(forced?.attribution).toEqual([{ label: "internal.test" }]);
  });

  it("rejects malformed shapes with the documented wordings", async () => {
    expect(await message(resolveCustomBasemapWrite(42, inspecting(VALID)))).toContain(
      "customBasemap must be",
    );
    expect(
      await message(resolveCustomBasemapWrite({ url: "  " }, inspecting(VALID))),
    ).toContain("non-empty");
    expect(
      await message(
        resolveCustomBasemapWrite(
          { url: "https://x.test/s", name: 7 },
          inspecting(VALID),
        ),
      ),
    ).toContain("name");
    expect(
      await message(
        resolveCustomBasemapWrite(
          { url: "https://x.test/s", force: "yes" },
          inspecting(VALID),
        ),
      ),
    ).toContain("force");
  });

  it("trims the name and rejects an oversize one outright", async () => {
    const trimmed = await resolveCustomBasemapWrite(
      { url: "https://x.test/s", name: "  Company dark  " },
      inspecting(VALID),
    );
    expect(trimmed?.name).toBe("Company dark");
    // oversize answers invalid_request, never a
    // silent truncation.
    expect(
      await message(
        resolveCustomBasemapWrite(
          { url: "https://x.test/s", name: "n".repeat(CUSTOM_NAME_MAX + 1) },
          inspecting(VALID),
        ),
      ),
    ).toContain(`${CUSTOM_NAME_MAX}`);
  });
});
