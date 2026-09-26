import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { NOTES_MAX, NOTE_TEXT_MAX, normalizeLayout, pruneLayout } from "./layout-document";

const steps = new Set(["s1", "s2"]);
const note = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  x: 20,
  y: 20,
  w: 420,
  h: 300,
  color: "yellow",
  text: "---\nlabel: intake\n---\n## Intake",
  ...over,
});

function refusal(body: unknown): string {
  try {
    normalizeLayout(body, steps);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(400);
    expect((e as ApiError).code).toBe("invalid_request");
    return (e as ApiError).message;
  }
  throw new Error("accepted");
}

function publishedBounds() {
  const document = buildOpenApiDocument() as unknown as {
    components: {
      schemas: {
        RecipeLayoutInput: {
          properties: Record<
            "steps" | "sources",
            { maxProperties: number; propertyNames: { maxLength: number } }
          >;
        };
      };
    };
  };
  const { steps, sources } =
    document.components.schemas.RecipeLayoutInput.properties;
  return {
    stepsMax: steps.maxProperties,
    sourcesMax: sources.maxProperties,
    stepKeyMax: steps.propertyNames.maxLength,
    sourceKeyMax: sources.propertyNames.maxLength,
  };
}

const positionMap = (count: number, prefix: string) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `${prefix}${index}`,
      { x: index, y: index },
    ]),
  );

describe("the layout document's shape", () => {
  it("accepts a full document and returns it in the stored form", () => {
    const doc = normalizeLayout(
      {
        steps: { s1: { x: 40, y: 60 }, s2: { x: 360.5, y: -40 } },
        sources: { stations: { x: 40, y: 330 }, "Loose table": { x: 0, y: 0 } },
        notes: [note(), note({ id: "n2", color: "grey", text: "" })],
      },
      steps,
    );
    expect(doc).toEqual({
      steps: { s1: { x: 40, y: 60 }, s2: { x: 360.5, y: -40 } },
      sources: { stations: { x: 40, y: 330 }, "Loose table": { x: 0, y: 0 } },
      notes: [note(), note({ id: "n2", color: "grey", text: "" })],
    });
  });

  it("reads an absent map or list as empty, so {} is the empty document", () => {
    expect(normalizeLayout({}, steps)).toEqual({ steps: {}, sources: {}, notes: [] });
    expect(normalizeLayout({ notes: [] }, steps)).toEqual({ steps: {}, sources: {}, notes: [] });
  });

  it("drops a position for a node the recipe does not have, and keeps the rest", () => {
    const doc = normalizeLayout(
      { steps: { s1: { x: 1, y: 2 }, gone: { x: 3, y: 4 } }, sources: { t: { x: 5, y: 6 } } },
      steps,
    );
    expect(doc.steps).toEqual({ s1: { x: 1, y: 2 } });
    expect(doc.sources).toEqual({ t: { x: 5, y: 6 } });
    expect(pruneLayout({ steps: { s2: { x: 0, y: 0 }, s9: { x: 0, y: 0 } }, sources: {}, notes: [] }, steps).steps)
      .toEqual({ s2: { x: 0, y: 0 } });
  });

  describe("position-map bounds", () => {
    const bounds = publishedBounds();
    const countCases = [
      ["steps", bounds.stepsMax] as const,
      ["sources", bounds.sourcesMax] as const,
    ];
    const keyCases = [
      ["steps", bounds.stepKeyMax] as const,
      ["sources", bounds.sourceKeyMax] as const,
    ];

    it("reads every published bound as a positive integer", () => {
      for (const [name, value] of Object.entries(bounds)) {
        expect(
          Number.isInteger(value) && value > 0,
          `${name}: ${String(value)}`,
        ).toBe(true);
      }
    });

    it.each(countCases)(
      "refuses %s one entry beyond its published count",
      (map, maximum) => {
        expect(
          refusal({ [map]: positionMap(maximum + 1, `${map}-`) }),
        ).toBe(
          `${map} holds ${maximum + 1}; a document holds at most ${maximum}.`,
        );
      },
    );

    it.each(keyCases)(
      "refuses a %s key one character beyond its published length before its value",
      (map, maximum) => {
        const key = "k".repeat(maximum + 1);
        expect(refusal({ [map]: { [key]: { x: "bad", y: 0 } } })).toBe(
          `${map} has a key of ${maximum + 1} characters; a key holds at most ${maximum}.`,
        );
      },
    );

    it.each(countCases)(
      "accepts %s at its published count before pruning",
      (map, maximum) => {
        const document = normalizeLayout(
          { [map]: positionMap(maximum, `${map}-boundary-`) },
          steps,
        );
        if (map === "steps") {
          expect(document.steps).toEqual({});
        } else {
          expect(Object.keys(document.sources)).toHaveLength(maximum);
        }
      },
    );

    it.each(keyCases)(
      "accepts a %s key at its published length before pruning",
      (map, maximum) => {
        const key = "k".repeat(maximum);
        const document = normalizeLayout(
          { [map]: { [key]: { x: 1, y: 2 } } },
          steps,
        );
        if (map === "steps") {
          expect(document.steps).toEqual({});
        } else {
          expect(document.sources).toHaveProperty(key, { x: 1, y: 2 });
        }
      },
    );

    it.each(keyCases)(
      "counts a %s astral-plane key in Unicode code points",
      (map, maximum) => {
        const onePast = "😀".repeat(maximum + 1);
        expect(refusal({ [map]: { [onePast]: { x: 1, y: 2 } } })).toBe(
          `${map} has a key of ${maximum + 1} characters; a key holds at most ${maximum}.`,
        );

        const atBoundary = "😀".repeat(maximum);
        const document = normalizeLayout(
          { [map]: { [atBoundary]: { x: 1, y: 2 } } },
          steps,
        );
        if (map === "steps") {
          expect(document.steps).toEqual({});
        } else {
          expect(document.sources).toHaveProperty(atBoundary, { x: 1, y: 2 });
        }
      },
    );
  });

  it("keeps a note's text verbatim, label line and all, up to the limit", () => {
    const text = "---\nlabel: intake\n---\n" + "x".repeat(NOTE_TEXT_MAX - 22);
    expect(text.length).toBe(NOTE_TEXT_MAX);
    expect(normalizeLayout({ notes: [note({ text })] }, steps).notes[0].text).toBe(text);
  });

  describe("refuses whole, naming the first fault", () => {
    it("a body that is not an object", () => {
      expect(refusal([])).toMatch(/JSON object/);
      expect(refusal("layout")).toMatch(/JSON object/);
      expect(refusal(null)).toMatch(/JSON object/);
    });
    it("a position that is not two finite numbers", () => {
      expect(refusal({ steps: { s1: { x: "40", y: 60 } } })).toBe("steps.s1.x must be a finite number.");
      expect(refusal({ steps: { s1: { x: 40 } } })).toBe("steps.s1.y must be a finite number.");
      expect(refusal({ sources: { t: { x: Infinity, y: 0 } } })).toBe("sources.t.x must be a finite number.");
      expect(refusal({ sources: { t: [1, 2] } })).toMatch(/sources\.t must be an object/);
      expect(refusal({ steps: [] })).toMatch(/steps must be an object/);
    });
    it("a note with a colour outside the six", () => {
      expect(refusal({ notes: [note({ color: "teal" })] })).toBe(
        "notes[0].color must be one of yellow, green, blue, pink, purple, grey.",
      );
    });
    it("a note text past the limit", () => {
      expect(refusal({ notes: [note({ text: "x".repeat(NOTE_TEXT_MAX + 1) })] })).toMatch(
        /notes\[0\]\.text is 4001 characters; a note holds at most 4000/,
      );
    });
    it("a note with a non-positive width or height", () => {
      expect(refusal({ notes: [note({ w: 0 })] })).toBe("notes[0].w must be positive.");
      expect(refusal({ notes: [note({ h: -10 })] })).toBe("notes[0].h must be positive.");
      expect(refusal({ notes: [note({ w: NaN })] })).toBe("notes[0].w must be a finite number.");
    });
    it("a note with a blank identity, or two sharing one", () => {
      expect(refusal({ notes: [note({ id: "  " })] })).toBe("notes[0].id must be a non-blank string.");
      expect(refusal({ notes: [note({ id: 7 })] })).toBe("notes[0].id must be a non-blank string.");
      expect(refusal({ notes: [note(), note({ x: 1 }), note({ id: "n1", y: 2 })] })).toBe(
        'notes[1].id duplicates notes[0].id ("n1").',
      );
    });
    it("a document of one note too many", () => {
      const many = Array.from({ length: NOTES_MAX + 1 }, (_, i) => note({ id: `n${i}` }));
      expect(refusal({ notes: many })).toBe("notes holds 101; a document holds at most 100.");
      const enough = many.slice(0, NOTES_MAX);
      expect(normalizeLayout({ notes: enough }, steps).notes).toHaveLength(NOTES_MAX);
    });
    it("a note missing a field, and notes that are not a list", () => {
      const noText = { id: "n1", x: 20, y: 20, w: 420, h: 300, color: "yellow" };
      expect(refusal({ notes: [noText] })).toBe("notes[0].text must be a string.");
      expect(refusal({ notes: [{ id: "n1" }] })).toBe("notes[0].w must be a finite number.");
      expect(refusal({ notes: {} })).toBe("notes must be an array.");
      expect(refusal({ notes: ["n"] })).toBe("notes[0] must be an object.");
    });
  });
});
