import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createCustomPalette } from "@/lib/metadata/palettes";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { classifyFill, computeSizeScale, niceBreaks } from "./classify";
import { legendFor } from "./legend";
import {
  isValidStyle,
  normalizeStyle,
  styleProblem,
  type LayerStyle,
  type SizeScale,
} from "./style";
import { defaultStyle } from "./defaults";
import {
  PALETTES,
  paletteByName,
  paletteSwatch,
  sequentialColors,
} from "./palettes";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "cities.csv");
  const rows = ["name,lon,lat,pop,region"];
  // Skewed population: one huge, rest small — quantiles must still split them.
  const data = [
    ["a", 13.4, 52.5, 9000000, "north"],
    ["b", 13.3, 52.4, 120, "north"],
    ["c", 13.2, 52.6, 300, "south"],
    ["d", 13.1, 52.7, 800, "south"],
    ["e", 13.0, 52.8, 2000, "east"],
    ["f", 12.9, 52.9, 5000, "east"],
  ];
  for (const r of data) rows.push(r.join(","));
  await writeFile(src, rows.join("\n"));
  await ingestFile(src, "cities.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const SQL = "SELECT name, pop, region, geometry FROM cities";

describe("classifyFill quantile", () => {
  it("splits skewed numeric data into distinct classes", async () => {
    const fill = await classifyFill(SQL, "pop", "quantile");
    if (fill.type !== "quantile") throw new Error("expected quantile");
    expect(fill.attribute).toBe("pop");
    expect(fill.colors.length).toBe(fill.breaks.length + 1);
    expect(fill.breaks.length).toBeGreaterThan(1);
    // breaks are strictly increasing
    for (let i = 1; i < fill.breaks.length; i++) {
      expect(fill.breaks[i]).toBeGreaterThan(fill.breaks[i - 1]);
    }
  });

  it("rejects quantile on a non-numeric column", async () => {
    await expect(classifyFill(SQL, "region", "quantile")).rejects.toMatchObject(
      { code: "invalid_request" },
    );
  });

  it("defaults to kepler's Global Warming ramp", async () => {
    const fill = await classifyFill(SQL, "pop", "quantile");
    if (fill.type !== "quantile") throw new Error("expected quantile");
    expect(fill.palette).toBe("global_warming");
  });

  it("honors palette, class count, and reverse", async () => {
    const fill = await classifyFill(SQL, "pop", "quantile", {
      palette: "ice_and_fire",
      classes: 4,
      reversed: true,
    });
    if (fill.type !== "quantile") throw new Error("expected quantile");
    expect(fill.palette).toBe("ice_and_fire");
    expect(fill.reversed).toBe(true);
    expect(fill.colors.length).toBeLessThanOrEqual(4);
    const sparse = await classifyFill(
      `SELECT * FROM (${SQL}) AS sparse LIMIT 1`,
      "pop",
      "quantile",
      { classes: 4 },
    );
    if (sparse.type !== "quantile") throw new Error("expected quantile");
    expect(sparse.colors).toHaveLength(2);
    expect(sparse.classes).toBe(4);
    await expect(
      classifyFill(SQL, "pop", "quantile", { palette: "nope" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      classifyFill(SQL, "pop", "quantile", { classes: 40 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("classifyFill equal intervals", () => {
  it("produces evenly spaced nice breaks between min and max", async () => {
    const fill = await classifyFill(SQL, "pop", "equal", { classes: 5 });
    if (fill.type !== "quantile") throw new Error("expected ramp fill");
    expect(fill.method).toBe("equal");
    expect(fill.breaks.length).toBe(4);
    // Nice rounding may nudge each boundary within its margin, so gaps are
    // approximately even rather than exact.
    const gaps = fill.breaks.slice(1).map((b, i) => b - fill.breaks[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    for (const g of gaps) expect(Math.abs(g - mean) / mean).toBeLessThan(0.25);
    // pop is an integer column: every break is a whole number.
    for (const b of fill.breaks) expect(Number.isInteger(b)).toBe(true);
  });
});

describe("custom scale mode", () => {
  it("accepts method custom with a base method; rejects a bad base", () => {
    const base = defaultStyle("POINT");
    const ramp = {
      type: "quantile",
      attribute: "pop",
      palette: "global_warming",
      method: "custom",
      baseMethod: "natural",
      breaks: [100, 500],
      colors: [
        { r: 1, g: 1, b: 1, a: 1 },
        { r: 2, g: 2, b: 2, a: 1 },
        { r: 3, g: 3, b: 3, a: 1 },
      ],
    };
    expect(styleProblem({ ...base, fill: { ...ramp, classes: 4 } })).toBeNull();
    expect(
      styleProblem({ ...base, fill: { ...ramp, classes: 1 } }),
    ).toMatch(/fill/);
    expect(
      styleProblem({ ...base, fill: { ...ramp, baseMethod: "custom" } }),
    ).toMatch(/fill/);
    expect(
      styleProblem({ ...base, fill: { ...ramp, method: "fancy" } }),
    ).toMatch(/fill/);
  });
});

describe("compact formatting of micro magnitudes", () => {
  it("switches to exponent form below the threshold, trimmed", async () => {
    const { formatCompact } = await import("./legend");
    expect(formatCompact(0.0000213)).toBe("2.13e-5");
    expect(formatCompact(0.00005)).toBe("5e-5");
    expect(formatCompact(-0.00002)).toBe("-2e-5");
    // At and above the threshold, decimals as before.
    expect(formatCompact(0.0001)).toBe("0.0001");
    expect(formatCompact(0.25)).toBe("0.25");
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(22310)).toBe("22,300");
  });

  it("breaks display exactly — stored equals shown", async () => {
    const { formatBreak, formatCompact } = await import("./legend");
    // The compact form may approximate; the break form never does.
    expect(formatCompact(16890)).toBe("16,900");
    expect(formatBreak(16890)).toBe("16,890");
    expect(formatBreak(12.5)).toBe("12.5");
    expect(formatBreak(0.0000125)).toBe("1.25e-5");
    // Earlier raw breaks show their true noise until reclassified.
    expect(formatBreak(243.1755)).toBe("243.1755");
  });
});

describe("nice breaks", () => {
  it("wide ranges get whole numbers", () => {
    const nice = niceBreaks([243.1755, 434.8945, 941.1685, 2047.156], {
      lo: 10,
      hi: 2500,
    });
    expect(nice).toHaveLength(4);
    for (const b of nice) {
      expect(Number.isInteger(b)).toBe(true);
      expect(String(b)).toMatch(/0$/); // round, not just truncated
    }
  });

  it("a 0-1 range keeps a couple of decimals; micro ranges keep enough", () => {
    const unit = niceBreaks([0.213456, 0.478123, 0.734567], { lo: 0, hi: 1 });
    for (const b of unit) {
      expect(String(b).replace(/^0\.|-/g, "").length).toBeLessThanOrEqual(3);
    }
    const micro = niceBreaks([0.0000213, 0.0000478, 0.0000734], {
      lo: 0.00001,
      hi: 0.00008,
    });
    expect(micro).toHaveLength(3);
    for (let i = 1; i < micro.length; i++) {
      expect(micro[i]).toBeGreaterThan(micro[i - 1]);
    }
    expect(micro[0]).toBeCloseTo(0.0000213, 6);
  });

  it("integer columns snap to integers and dedupe collapsed classes", () => {
    const nice = niceBreaks([1.5, 2.4, 2.6, 800.3], { integer: true });
    for (const b of nice) expect(Number.isInteger(b)).toBe(true);
    const set = new Set(nice);
    expect(set.size).toBe(nice.length);
  });

  it("separation wins: tight clusters keep exact values, always ascending", () => {
    const tight = niceBreaks([1.02, 1.021, 1.022], { lo: 1, hi: 1.03 });
    expect(tight).toHaveLength(3);
    for (let i = 1; i < tight.length; i++) {
      expect(tight[i]).toBeGreaterThan(tight[i - 1]);
    }
  });

  it("rounding never crosses the data extent", () => {
    // A first break near the minimum must not round below it (an empty
    // first class), even when the gap to the next break is huge.
    const nice = niceBreaks([12, 500, 1500], { lo: 10, hi: 2500 });
    expect(nice[0]).toBeGreaterThanOrEqual(10);
    expect(nice[nice.length - 1]).toBeLessThanOrEqual(2500);
  });

  it("handles empty and single-break inputs", () => {
    expect(niceBreaks([])).toEqual([]);
    expect(niceBreaks([42.0001], { lo: 42.0001, hi: 42.0001 })).toEqual([
      42.0001,
    ]);
  });
});

describe("natural breaks", () => {
  it("clusters values instead of splitting them (pure algorithm)", async () => {
    const { naturalBreakValues } = await import("./natural-breaks");
    // Two tight clusters: the boundary must fall between them, not inside.
    expect(naturalBreakValues([1, 1, 1, 2, 2, 10, 11, 12], 2)).toEqual([2]);
    // Three clusters, three classes.
    expect(naturalBreakValues([1, 2, 20, 21, 100, 101], 3)).toEqual([2, 21]);
    // Fewer distinct values than classes → fewer boundaries, never padding.
    expect(naturalBreakValues([5, 5, 5], 4)).toEqual([]);
    expect(naturalBreakValues([1, 1, 9, 9], 4)).toEqual([1]);
    expect(naturalBreakValues([], 5)).toEqual([]);
  });

  it("isolates the outlier on skewed data where quantile splits clusters", async () => {
    const fill = await classifyFill(SQL, "pop", "natural", { classes: 3 });
    if (fill.type !== "quantile") throw new Error("expected ramp fill");
    expect(fill.method).toBe("natural");
    // The 9,000,000 outlier sits alone above the last boundary; the small
    // towns stay together below the first.
    expect(fill.breaks.length).toBe(2);
    expect(fill.breaks[1]).toBeGreaterThanOrEqual(5000);
    expect(fill.breaks[1]).toBeLessThan(9000000);
    expect(fill.colors.length).toBe(3);
  });

  it("rejects natural breaks on a non-numeric column", async () => {
    await expect(classifyFill(SQL, "region", "natural")).rejects.toMatchObject(
      { code: "invalid_request" },
    );
  });
});

describe("computeSizeScale", () => {
  it("resolves the attribute's range over the given result", async () => {
    const scale = await computeSizeScale(SQL, "pop", [4, 28]);
    expect(scale).toEqual({
      attribute: "pop",
      domain: [120, 9000000],
      range: [4, 28],
    });
  });

  it("respects the effective result it is given (filters shrink the domain)", async () => {
    const scale = await computeSizeScale(
      `SELECT * FROM (${SQL}) AS f WHERE pop < 10000`,
      "pop",
      [2, 20],
    );
    expect(scale.domain).toEqual([120, 5000]);
  });

  it("explains non-numeric and empty attributes", async () => {
    await expect(computeSizeScale(SQL, "region", [4, 28])).rejects.toMatchObject(
      { code: "invalid_request" },
    );
    await expect(
      computeSizeScale(`SELECT * FROM (${SQL}) AS f WHERE 1=0`, "pop", [4, 28]),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("classifyFill categorical", () => {
  it("assigns a distinct color per category", async () => {
    const fill = await classifyFill(SQL, "region", "categorical");
    if (fill.type !== "categorical") throw new Error("expected categorical");
    expect(fill.map.map((m) => m.value).sort()).toEqual([
      "east",
      "north",
      "south",
    ]);
    const colors = new Set(fill.map.map((m) => JSON.stringify(m.color)));
    expect(colors.size).toBe(3);
  });
});

describe("legendFor", () => {
  it("returns null for an all-constant style", () => {
    expect(legendFor(defaultStyle("POINT"))).toBeNull();
  });

  it("produces range labels for quantile and value labels for categorical", async () => {
    const q = await classifyFill(SQL, "pop", "quantile");
    const style: LayerStyle = { ...defaultStyle("POINT"), fill: q };
    const legend = legendFor(style)?.paints[0];
    expect(legend?.kind).toBe("quantile");
    expect(legend?.entries[0].label).toMatch(/^</);
    expect(legend?.entries.at(-1)?.label).toMatch(/^≥/);

    const cat = await classifyFill(SQL, "region", "categorical");
    const legend2 = legendFor({ ...style, fill: cat })?.paints[0];
    expect(legend2?.kind).toBe("categorical");
    expect(legend2?.entries.at(-1)?.label).toBe("other");
  });

  it("shows every data-driven channel: outline classes and size rows", async () => {
    const strokeBy = await classifyFill(SQL, "region", "categorical");
    const style: LayerStyle = {
      ...defaultStyle("POINT"),
      strokeBy,
      pointRadiusBy: { attribute: "pop", domain: [120, 9000000], range: [4, 28] },
    };
    const legend = legendFor(style);
    // Constant fill contributes nothing; outline and radius do.
    expect(legend?.paints.map((p) => p.channel)).toEqual(["stroke"]);
    expect(legend?.sizes.map((s) => s.channel)).toEqual(["radius"]);
    expect(legend?.sizes[0].labels).toEqual(["120", "9,000,000"]);
    // Slot count spans all channels: 3 regions + other + one size row.
    const { legendSlotCount } = await import("./legend");
    expect(legendSlotCount(style)).toBe(5);
    expect(legendSlotCount(defaultStyle("POINT"))).toBe(0);
  });
});

describe("isValidStyle", () => {
  it("accepts the default and computed styles, rejects malformed", async () => {
    expect(isValidStyle(defaultStyle("POLYGON"))).toBe(true);
    const q = await classifyFill(SQL, "pop", "quantile");
    expect(isValidStyle({ ...defaultStyle("POINT"), fill: q })).toBe(true);
    expect(isValidStyle({ fill: { type: "constant" } })).toBe(false);
    expect(isValidStyle({ ...defaultStyle("POINT"), opacity: 5 })).toBe(false);
    expect(isValidStyle({ ...defaultStyle("POINT"), fillOpacity: 5 })).toBe(
      false,
    );
  });

  it("accepts earlier styles without split opacities; normalize fills them", () => {
    const legacy: Record<string, unknown> = { ...defaultStyle("POINT") };
    delete legacy.fillOpacity;
    delete legacy.strokeOpacity;
    expect(isValidStyle(legacy)).toBe(true);
    const normalized = normalizeStyle(legacy);
    expect(normalized.fillOpacity).toBe(1);
    expect(normalized.strokeOpacity).toBe(1);
  });
});

describe("label config", () => {
  const label = {
    attribute: "name",
    size: 12,
    color: { r: 255, g: 255, b: 255, a: 1 },
    haloWidth: 1, haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
  };

  it("accepts attribute labels and attribute-less (aggregated) labels", () => {
    const base = defaultStyle("POINT");
    expect(styleProblem({ ...base, label })).toBeNull();
    const aggregated = { size: 12, color: label.color, haloWidth: 1, haloColor: { r: 12, g: 16, b: 24, a: 0.8 } };
    expect(styleProblem({ ...base, label: aggregated })).toBeNull();
    expect(styleProblem(base)).toBeNull();
  });

  it("explains malformed labels instead of just refusing", () => {
    const base = defaultStyle("POINT");
    expect(
      styleProblem({ ...base, label: { ...label, attribute: "" } }),
    ).toMatch(/attribute/);
    expect(styleProblem({ ...base, label: { ...label, size: 0 } })).toMatch(
      /size/,
    );
    expect(styleProblem({ ...base, label: { ...label, size: 500 } })).toMatch(
      /size/,
    );
    expect(
      styleProblem({
        ...base,
        label: { ...label, color: { r: 999, g: 0, b: 0, a: 1 } },
      }),
    ).toMatch(/color/);
    expect(styleProblem({ ...base, label: { ...label, halo: "yes" } })).toMatch(
      /halo/,
    );
  });
});

describe("data-driven channels", () => {
  const scale: SizeScale = {
    attribute: "pop",
    domain: [120, 9000000],
    range: [4, 28],
  };

  it("accepts a style with outline paint and size scales", async () => {
    const strokeBy = await classifyFill(SQL, "region", "categorical");
    const style: LayerStyle = {
      ...defaultStyle("POINT"),
      strokeBy,
      pointRadiusBy: scale,
      strokeWidthBy: { ...scale, range: [1, 8] },
    };
    expect(styleProblem(style)).toBeNull();
  });

  it("explains malformed scales instead of just refusing", () => {
    const base = defaultStyle("POINT");
    expect(
      styleProblem({ ...base, pointRadiusBy: { ...scale, domain: [9, 1] } }),
    ).toMatch(/domain/);
    expect(
      styleProblem({ ...base, pointRadiusBy: { ...scale, range: [28, 4] } }),
    ).toMatch(/range/);
    expect(
      styleProblem({ ...base, pointRadiusBy: { ...scale, range: [0, 9999] } }),
    ).toMatch(/range/);
    expect(
      styleProblem({ ...base, strokeWidthBy: { ...scale, attribute: "" } }),
    ).toMatch(/attribute/);
  });

  it("rejects out-of-order class boundaries with an explanation", async () => {
    const q = await classifyFill(SQL, "pop", "quantile");
    if (q.type !== "quantile") throw new Error("expected quantile");
    const scrambled = { ...q, breaks: [...q.breaks].reverse() };
    const problem = styleProblem({ ...defaultStyle("POINT"), fill: scrambled });
    expect(problem).toMatch(/ascending/);
    const equal = { ...q, breaks: q.breaks.map(() => 5) };
    expect(
      styleProblem({ ...defaultStyle("POINT"), strokeBy: equal }),
    ).toMatch(/ascending/);
  });

  it("reads every prior-feature style shape identically", () => {
    // As persisted (no split opacities), (categorical fill), and
    // (quantile fill with method) — absence of the members must mean
    // exactly today's constants.
    const fixtures: Record<string, unknown>[] = [
      {
        fill: { type: "constant", color: { r: 18, g: 147, b: 154, a: 0.72 } },
        stroke: { r: 12, g: 16, b: 24, a: 0.85 },
        strokeWidth: 1,
        pointRadius: 5,
        opacity: 1,
      },
      {
        fill: {
          type: "categorical",
          attribute: "region",
          palette: "uber_viz_qualitative",
          map: [{ value: "north", color: { r: 18, g: 147, b: 154, a: 0.82 } }],
          other: { r: 120, g: 130, b: 150, a: 0.55 },
        },
        fillOpacity: 0.9,
        stroke: { r: 12, g: 16, b: 24, a: 0.85 },
        strokeOpacity: 1,
        strokeWidth: 1,
        pointRadius: 5,
        opacity: 1,
      },
      {
        fill: {
          type: "quantile",
          attribute: "pop",
          palette: "global_warming",
          method: "equal",
          breaks: [10, 20],
          colors: [
            { r: 90, g: 24, b: 70, a: 0.82 },
            { r: 199, g: 0, b: 57, a: 0.82 },
            { r: 255, g: 195, b: 0, a: 0.82 },
          ],
        },
        fillOpacity: 1,
        stroke: { r: 12, g: 16, b: 24, a: 0.85 },
        strokeOpacity: 1,
        strokeWidth: 1,
        pointRadius: 5,
        opacity: 1,
      },
    ];
    for (const fixture of fixtures) {
      expect(styleProblem(fixture)).toBeNull();
      const normalized = normalizeStyle(fixture) as unknown as Record<
        string,
        unknown
      >;
      // Nothing invented: no members appear, constants untouched.
      expect(normalized.strokeBy).toBeUndefined();
      expect(normalized.pointRadiusBy).toBeUndefined();
      expect(normalized.strokeWidthBy).toBeUndefined();
      expect(normalized.pointRadius).toBe(fixture.pointRadius);
      expect(normalized.strokeWidth).toBe(fixture.strokeWidth);
    }

    // Colors are solid; the sliders own translucency. Legacy authored
    // alpha folds into the sliders exactly — the effective (rendered)
    // alpha per class is unchanged, and folding again is a no-op.
    const [legacy, categorical, quantile] = fixtures.map(
      (fixture) => normalizeStyle(fixture),
    );
    expect(legacy.fill).toEqual({
      type: "constant",
      color: { r: 18, g: 147, b: 154, a: 1 },
    });
    expect(legacy.fillOpacity).toBe(0.72);
    expect(legacy.stroke).toEqual({ r: 12, g: 16, b: 24, a: 1 });
    expect(legacy.strokeOpacity).toBe(0.85);

    if (categorical.fill.type !== "categorical") throw new Error("shape");
    expect(categorical.fill.map[0].color.a).toBe(1);
    // Mixed authored alphas keep their ratio: 0.55/0.82 of the channel max.
    expect(categorical.fill.other.a).toBeCloseTo(0.55 / 0.82, 10);
    expect(categorical.fillOpacity).toBeCloseTo(0.9 * 0.82, 10);
    expect(categorical.fill.other.a * categorical.fillOpacity).toBeCloseTo(
      0.55 * 0.9,
      10,
    );

    if (quantile.fill.type !== "quantile") throw new Error("shape");
    expect(quantile.fill.colors.map((c) => c.a)).toEqual([1, 1, 1]);
    expect(quantile.fillOpacity).toBeCloseTo(0.82, 10);
    expect(normalizeStyle(quantile)).toEqual(quantile);
  });
});

describe("palette catalogue", () => {
  it("holds the kepler defaults with exact inherited values", () => {
    expect(paletteByName("global_warming", "sequential")?.colors).toEqual([
      "#5A1846", "#900C3F", "#C70039", "#E3611C", "#F1920E", "#FFC300",
    ]);
    const qualitative = paletteByName("uber_viz_qualitative", "categorical");
    expect(qualitative?.colors[0]).toBe("#12939A"); // kepler's signature teal
    expect(qualitative?.colors).toHaveLength(20);
  });
});

describe("curated palette catalogue", () => {
  const hexOf = (c: { r: number; g: number; b: number }) =>
    "#" + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join("");

  it("is exactly the 23 curated palettes in three groups", () => {
    expect(PALETTES).toHaveLength(23);
    const names = (g: string) =>
      PALETTES.filter((p) => p.group === g).map((p) => p.name);
    expect(names("sequential")).toEqual([
      "global_warming", "sunrise", "uber_viz_sequential", "viridis", "plasma",
      "inferno", "greys", "blues", "greens", "reds", "ylorrd", "turbo",
    ]);
    expect(names("diverging")).toEqual([
      "ice_and_fire", "rdbu", "piyg", "spectral", "berlin",
    ]);
    expect(names("qualitative")).toEqual([
      "uber_viz_qualitative", "bold", "tab10", "paired", "dark2", "set3",
    ]);
    // The browsing group refines the mechanical kind: diverging ramps keep
    // kind "sequential" — same methods, steps, reverse, validation.
    for (const p of PALETTES) {
      expect(p.kind).toBe(
        p.group === "qualitative" ? "categorical" : "sequential",
      );
    }
  });

  it("flags colorblind safety only where upstream designates it", () => {
    const safe = PALETTES.filter((p) => p.colorblindSafe)
      .map((p) => p.name)
      .sort();
    expect(safe).toEqual([
      "berlin", "blues", "greens", "greys", "inferno", "piyg",
      "plasma", "rdbu", "reds", "viridis", "ylorrd",
    ]);
  });

  it("renders ColorBrewer sets as ColorBrewer's own k-class colors", () => {
    // Published values from colorbrewer2.org (Apache-2.0) — exact per-count
    // sets, not samples of a longer ramp.
    expect(sequentialColors(3, "blues").map(hexOf)).toEqual([
      "#deebf7", "#9ecae1", "#3182bd",
    ]);
    expect(sequentialColors(7, "blues").map(hexOf)).toEqual([
      "#eff3ff", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#084594",
    ]);
    expect(sequentialColors(5, "rdbu").map(hexOf)).toEqual([
      "#ca0020", "#f4a582", "#f7f7f7", "#92c5de", "#0571b0",
    ]);
    // Reversed applies the same published set back-to-front.
    expect(sequentialColors(3, "blues", true).map(hexOf)).toEqual([
      "#3182bd", "#9ecae1", "#deebf7",
    ]);
    // Colors are solid — translucency belongs to the opacity sliders.
    expect(sequentialColors(3, "blues")[0].a).toBe(1);
  });

  it("samples continuous curves at matplotlib's published stops", () => {
    // k=4 and k=6 land on integer stop indices (0,85,170,255 / 0,51,…,255),
    // so these are the upstream sRGB values verbatim.
    expect(sequentialColors(4, "viridis").map(hexOf)).toEqual([
      "#440154", "#31688e", "#35b779", "#fde725",
    ]);
    expect(sequentialColors(6, "viridis").map(hexOf)).toEqual([
      "#440154", "#414487", "#2a788e", "#22a884", "#7ad151", "#fde725",
    ]);
  });

  it("draws picker swatches discretized at the class count", () => {
    const blues = paletteByName("blues", "sequential")!;
    expect(paletteSwatch(blues, 5)).toEqual([
      "#eff3ff", "#bdd7e7", "#6baed6", "#3182bd", "#08519c",
    ]);
    const tab10 = paletteByName("tab10", "categorical")!;
    expect(paletteSwatch(tab10, 5)).toHaveLength(10); // cycles show themselves
    expect(paletteSwatch(tab10, 5)[0]).toBe("#1f77b4");
  });

  it("keeps stored styles with retired palette names rendering as saved", async () => {
    // An earlier style that classified with a retired palette persists its
    // computed colors — the name is provenance, not needed to render.
    const style: Record<string, unknown> = {
      ...defaultStyle("POINT"),
      fill: {
        type: "quantile",
        attribute: "pop",
        palette: "emerald",
        method: "quantile",
        breaks: [500, 5000],
        colors: [
          { r: 211, g: 242, b: 163, a: 0.82 },
          { r: 108, g: 192, b: 139, a: 0.82 },
          { r: 16, g: 89, b: 101, a: 0.82 },
        ],
      },
    };
    expect(styleProblem(style)).toBeNull();
    // Classifying anew with a retired name is rejected with an explanation.
    await expect(
      classifyFill(SQL, "pop", "quantile", { palette: "emerald" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      classifyFill(SQL, "region", "categorical", { palette: "pink_wine" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("classifies with a new palette end to end", async () => {
    const fill = await classifyFill(SQL, "pop", "quantile", {
      palette: "viridis",
      classes: 5,
    });
    if (fill.type !== "quantile") throw new Error("expected quantile");
    expect(fill.palette).toBe("viridis");
    const cat = await classifyFill(SQL, "region", "categorical", {
      palette: "tab10",
    });
    if (cat.type !== "categorical") throw new Error("expected categorical");
    expect(hexOf(cat.map[0].color)).toBe("#1f77b4");
  });
});

describe("new-layer defaults (quiet by default)", () => {
  it("points and polygons start with no outline; small points", () => {
    const point = defaultStyle("POINT");
    expect(point.strokeWidth).toBe(0);
    expect(point.pointRadius).toBe(3);
    const polygon = defaultStyle("POLYGON");
    expect(polygon.strokeWidth).toBe(0);
  });

  it("lines keep their visible stroke — it is the mark itself", () => {
    const line = defaultStyle("LINESTRING");
    expect(line.strokeWidth).toBe(2);
    expect(line.stroke.a).toBeGreaterThan(0.9);
  });
});

describe("classifyFill continuous", () => {
  it("resolves the domain and bakes ramp stops", async () => {
    const fill = await classifyFill(SQL, "pop", "continuous", {
      palette: "viridis",
    });
    if (fill.type !== "continuous") throw new Error("expected continuous");
    expect(fill.attribute).toBe("pop");
    expect(fill.palette).toBe("viridis");
    expect(fill.domain).toEqual([120, 9000000]);
    expect(fill.stops.length).toBeGreaterThanOrEqual(2);
    expect(fill.center).toBeUndefined();
    expect(styleProblem({ ...defaultStyle("POINT", 0), fill })).toBeNull();
  });

  it("centers diverging palettes on the field's mean", async () => {
    const fill = await classifyFill(SQL, "pop", "continuous", {
      palette: "rdbu",
    });
    if (fill.type !== "continuous") throw new Error("expected continuous");
    const mean = (9000000 + 120 + 300 + 800 + 2000 + 5000) / 6;
    expect(fill.center).toBeCloseTo(mean, 4);
  });

  it("rejects non-numeric columns and unknown palettes", async () => {
    await expect(
      classifyFill(SQL, "region", "continuous"),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      classifyFill(SQL, "pop", "continuous", { palette: "nope" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("applies a saved custom palette in both modes", async () => {
    const saved = createCustomPalette({
      label: "Brand",
      stops: [
        { color: "#000000", position: 0 },
        { color: "#ff0000", position: 0.8 },
        { color: "#ffffff", position: 1 },
      ],
    });
    const cont = await classifyFill(SQL, "pop", "continuous", {
      palette: saved.name,
    });
    if (cont.type !== "continuous") throw new Error("expected continuous");
    expect(cont.palette).toBe(saved.name);
    expect(cont.positions).toEqual([0, 0.8, 1]);
    const reversedFill = await classifyFill(SQL, "pop", "continuous", {
      palette: saved.name,
      reversed: true,
    });
    if (reversedFill.type !== "continuous")
      throw new Error("expected continuous");
    // Reversal flips both stop order and positions, still ascending.
    expect(reversedFill.positions?.[0]).toBe(0);
    expect(reversedFill.positions?.[1]).toBeCloseTo(0.2, 10);
    expect(reversedFill.positions?.[2]).toBe(1);
    expect(reversedFill.stops[0]).toMatchObject({ r: 255, g: 255, b: 255 });
    const classed = await classifyFill(SQL, "pop", "quantile", {
      palette: saved.name,
    });
    if (classed.type !== "quantile") throw new Error("expected quantile");
    expect(classed.palette).toBe(saved.name);
    expect(classed.colors[0]).toMatchObject({ r: 0, g: 0, b: 0 });
  });
});

describe("the halo migration and label domains", () => {
  const base = {
    attribute: "name",
    size: 12,
    color: { r: 255, g: 255, b: 255, a: 1 },
  };

  it("migrates the legacy boolean at read: true pins the historical rim exactly", () => {
    const migrated = normalizeStyle({
      ...defaultStyle("POINT"),
      label: { ...base, halo: true },
    });
    expect(migrated.label).toEqual({
      ...base,
      haloWidth: 1,
      haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
    });
    const off = normalizeStyle({
      ...defaultStyle("POINT"),
      label: { ...base, halo: false },
    });
    expect(off.label?.haloWidth).toBe(0);
    // Idempotent: the migrated shape passes through unchanged.
    expect(normalizeStyle(migrated).label).toEqual(migrated.label);
  });

  it("rejects the legacy boolean on writes with the documented wording", () => {
    expect(
      styleProblem({
        ...defaultStyle("POINT"),
        label: { ...base, halo: true, haloWidth: 1, haloColor: base.color },
      }),
    ).toContain("label.halo has been replaced");
  });

  it("validates each new domain with its field-specific wording", () => {
    const good = {
      ...base,
      haloWidth: 0.5,
      haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
    };
    const style = defaultStyle("POINT");
    expect(styleProblem({ ...style, label: good })).toBeNull();
    const cases: [Partial<Record<string, unknown>>, string][] = [
      [{ haloWidth: 1.5 }, "label.haloWidth"],
      [{ haloColor: "red" }, "label.haloColor"],
      [{ weight: "heavy" }, "label.weight"],
      [{ anchor: "middle" }, "label.anchor"],
      [{ offsetX: 51 }, "label.offsetX"],
      [{ offsetY: -51 }, "label.offsetY"],
      [{ rotation: 181 }, "label.rotation"],
      [{ textCase: "title" }, "label.textCase"],
      [{ maxChars: 0 }, "label.maxChars"],
      [{ maxChars: 81 }, "label.maxChars"],
      [{ density: 2 }, "label.density"],
      [{ zoomFloor: 25 }, "label.zoomFloor"],
      [{ priorityField: "" }, "label.priorityField"],
      [{ cap: 0 }, "label.cap"],
    ];
    for (const [bad, field] of cases) {
      expect(
        styleProblem({ ...style, label: { ...good, ...bad } }),
      ).toContain(field);
    }
    // Valid optionals pass whole.
    expect(
      styleProblem({
        ...style,
        label: {
          ...good,
          weight: "bold",
          anchor: "top-right",
          offsetX: 10,
          offsetY: -10,
          rotation: -45,
          textCase: "upper",
          maxChars: 12,
          density: 0.8,
          zoomFloor: 6,
          priorityField: "riders",
          cap: 300,
        },
      }),
    ).toBeNull();
  });
});
