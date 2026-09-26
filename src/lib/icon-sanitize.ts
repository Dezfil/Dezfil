/**
 * The custom-icon SVG sanitizer. One boundary for both the advisory
 * preview and the authoritative layer write: a strict, non-networked
 * XML parse behind a pre-scan that rejects DTDs, entities, and
 * processing instructions outright (the OWASP stance — declarations are
 * refused, never processed), then a closed element/attribute/value
 * policy in the SVG namespace. Everything outside the policy is dropped
 * and REPORTED — category and name only, never attacker-controlled
 * values re-rendered — and an input whose drawable content doesn't
 * survive is rejected, never silently emptied.
 *
 * Byte stability: input that needs no removal returns its
 * original bytes; changed output serializes deterministically and is
 * idempotent under re-sanitization. Raster sizing is the renderer's
 * job — persisted markup is never resized here.
 */

import { XMLParser, XMLBuilder, XMLValidator } from "fast-xml-parser";
import { ApiError } from "@/lib/api/errors";

/** The ratified proposal (I4), measured in UTF-8 bytes before parsing. */
export const ICON_SVG_BYTE_CAP = 256 * 1024;
const MAX_DEPTH = 32;
const MAX_ELEMENTS = 5_000;
const MAX_ATTR_LENGTH = 4_096;
const MAX_REPORT = 20;

export interface DroppedContent {
  kind: "element" | "attribute" | "declaration";
  name: string;
}

export interface SanitizedIcon {
  /** The accepted markup — original bytes when nothing was removed. */
  svg: string;
  changed: boolean;
  dropped: DroppedContent[];
  /** Width / height, from the root's viewBox or width/height — the
   * renderer derives its raster box from this; markup is untouched. */
  aspect: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Drawing and grouping only: every URL-bearing, executable, animation,
 * CSS, and indirection facility (use, defs, style, foreignObject…) is
 * outside the policy by construction. */
const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "title",
  "desc",
]);
/** What makes each primitive actually paintable — counted AFTER
 * attribute filtering (a <path onclick> whose only attribute
 * was stripped is not drawable), and COMPLETELY (a
 * <rect width="10"/> defaults height to zero and paints nothing — every
 * listed attribute must survive with a non-empty value; a line needs an
 * endpoint off the origin default). */
const DRAWABLE_GEOMETRY: Record<string, string[]> = {
  path: ["d"],
  polyline: ["points"],
  polygon: ["points"],
  circle: ["r"],
  ellipse: ["rx", "ry"],
  line: ["x2"],
  rect: ["width", "height"],
};

const ALLOWED_ATTRIBUTES = new Set([
  "xmlns",
  "viewBox",
  "width",
  "height",
  "d",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "points",
  "transform",
  "fill",
  "fill-rule",
  "fill-opacity",
  "clip-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
]);

/** Values may not carry references or markup of any kind. Backslashes
 * are rejected wholesale: CSS escapes (\75\72\6c… decodes to url())
 * would smuggle references straight past any textual denylist, and no
 * legitimate icon attribute needs one. */
const HOSTILE_VALUE = /url\s*\(|javascript:|data:|https?:|[<&\\]/i;

function invalid(message: string): never {
  throw new ApiError("invalid_request", message, 400);
}

type OrderedNode = Record<string, unknown> & { ":@"?: Record<string, unknown> };

const parser = new XMLParser({
  ignoreAttributes: false,
  preserveOrder: true,
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  commentPropName: "#comment",
  trimValues: false,
});
const builder = new XMLBuilder({
  ignoreAttributes: false,
  preserveOrder: true,
  processEntities: false,
  suppressEmptyNode: true,
});

/** Parse the root svg's aspect from viewBox or width/height; 1 when
 * neither is stated. A STATED-but-degenerate viewport rejects:
 * `viewBox="0 0 1e999 1"` yields Infinity, which JSON
 * serializes as null against the schema and decodes blank. */
function aspectOf(attrs: Record<string, unknown>): number {
  const viewBox = String(attrs["@_viewBox"] ?? "");
  if (viewBox.trim()) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (
      parts.length !== 4 ||
      parts.some((v) => !Number.isFinite(v)) ||
      parts[2] <= 0 ||
      parts[3] <= 0 ||
      parts[2] > 1e6 ||
      parts[3] > 1e6
    ) {
      invalid("The viewBox must carry four finite, sane dimensions.");
    }
    return parts[2] / parts[3];
  }
  const wText = String(attrs["@_width"] ?? "");
  const hText = String(attrs["@_height"] ?? "");
  if (wText || hText) {
    const w = Number.parseFloat(wText);
    const h = Number.parseFloat(hText);
    if (
      !Number.isFinite(w) ||
      !Number.isFinite(h) ||
      w <= 0 ||
      h <= 0 ||
      w > 1e6 ||
      h > 1e6
    ) {
      invalid("width and height must be finite, sane dimensions.");
    }
    return w / h;
  }
  return 1;
}

export function sanitizeSvgIcon(input: string): SanitizedIcon {
  if (typeof input !== "string" || !input.trim()) {
    invalid("The icon must be SVG text.");
  }
  if (Buffer.byteLength(input, "utf8") > ICON_SVG_BYTE_CAP) {
    invalid(
      `The icon must be at most ${ICON_SVG_BYTE_CAP / 1024} KB of SVG.`,
    );
  }
  // Declarations are refused, never processed (OWASP): no DTDs, no
  // entities, no processing instructions, no CDATA smuggling.
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml[\s?])|<!\[CDATA\[/i.test(input)) {
    invalid(
      "The SVG must not carry DOCTYPE, entity, CDATA, or processing " +
        "instructions.",
    );
  }

  // The parser is tolerant; the validator is not. Malformed-but-clean
  // input previously returned byte-stable with a 200 while the browser's
  // decoder rejected it into a blank icon.
  if (XMLValidator.validate(input) !== true) {
    invalid("The text is not well-formed SVG.");
  }
  let tree: OrderedNode[];
  try {
    tree = parser.parse(input) as OrderedNode[];
  } catch {
    invalid("The text is not well-formed SVG.");
  }

  const dropped: DroppedContent[] = [];
  let droppedTotal = 0;
  let changed = false;
  let elementCount = 0;
  let drawableCount = 0;
  const report = (kind: DroppedContent["kind"], name: string) => {
    changed = true;
    droppedTotal++;
    if (dropped.length < MAX_REPORT) {
      dropped.push({ kind, name: name.slice(0, 64) });
    }
  };

  const filterNodes = (nodes: OrderedNode[], depth: number): OrderedNode[] => {
    if (depth > MAX_DEPTH) invalid("The SVG nests deeper than the bound.");
    const kept: OrderedNode[] = [];
    for (const node of nodes) {
      const name = Object.keys(node).find((k) => k !== ":@");
      if (!name) continue;
      if (name === "#text") {
        // Free text only matters inside title/desc; keep it — values
        // are inert text after entity processing is off.
        kept.push(node);
        continue;
      }
      if (name === "#comment") {
        report("declaration", "comment");
        continue;
      }
      if (!ALLOWED_ELEMENTS.has(name)) {
        report("element", name);
        continue;
      }
      elementCount++;
      if (elementCount > MAX_ELEMENTS) {
        invalid("The SVG carries more elements than the bound.");
      }
      const attrs = (node[":@"] ?? {}) as Record<string, unknown>;
      const keptAttrs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(attrs)) {
        const attrName = key.replace(/^@_/, "");
        const text = String(value);
        if (!ALLOWED_ATTRIBUTES.has(attrName)) {
          report("attribute", attrName);
          continue;
        }
        if (attrName === "xmlns") {
          // Pinned to the one legal value — and exempt from the value
          // scan, whose URL test would otherwise reject the namespace
          // itself.
          if (text !== SVG_NS) {
            report("attribute", "xmlns");
            continue;
          }
        } else if (
          text.length > MAX_ATTR_LENGTH ||
          HOSTILE_VALUE.test(text)
        ) {
          report("attribute", attrName);
          continue;
        }
        keptAttrs[key] = value;
      }
      const children = node[name];
      const filteredChildren = Array.isArray(children)
        ? filterNodes(children as OrderedNode[], depth + 1)
        : children;
      const rebuilt: OrderedNode = { [name]: filteredChildren };
      if (Object.keys(keptAttrs).length) rebuilt[":@"] = keptAttrs;
      // Drawable only if its COMPLETE geometry survived the filter with
      // substance in every required value.
      const geometry = DRAWABLE_GEOMETRY[name];
      if (
        geometry &&
        geometry.every((attr) => {
          const value = keptAttrs[`@_${attr}`];
          return value !== undefined && String(value).trim() !== "";
        })
      ) {
        drawableCount++;
      }
      kept.push(rebuilt);
    }
    return kept;
  };

  const filtered = filterNodes(tree, 0);
  const rootNode = filtered.find((n) =>
    Object.keys(n).some((k) => k === "svg"),
  );
  if (!rootNode) invalid("The root element must be <svg>.");
  if (filtered.length !== tree.length) changed = true;
  if (drawableCount === 0) {
    invalid(
      "Nothing drawable survives sanitization: the SVG carries no " +
        "supported shapes.",
    );
  }

  // The image contexts the icon lives in (data URIs, atlases) require
  // the namespace on the root; inject it when absent.
  const rootAttrs = (rootNode[":@"] ?? {}) as Record<string, unknown>;
  if (rootAttrs["@_xmlns"] !== SVG_NS) {
    rootAttrs["@_xmlns"] = SVG_NS;
    rootNode[":@"] = rootAttrs;
    changed = true;
  }

  if (droppedTotal > dropped.length) {
    dropped.push({
      kind: "declaration",
      name: `and ${droppedTotal - dropped.length} more`,
    });
  }

  return {
    svg: changed ? builder.build(filtered) : input,
    changed,
    dropped,
    aspect: aspectOf(rootAttrs),
  };
}
