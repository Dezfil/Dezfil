import { ApiError } from "@/lib/api/errors";
import { MAX_FIELD_LIST } from "@/lib/column-validation";
import { sanitizeSvgIcon } from "@/lib/icon-sanitize";
import type { UpdateLayerFields } from "@/lib/layer-admission";
import type { LayerStyle } from "@/lib/style/style";
import {
  isValidViz,
  isValidFilters,
  isValidLegendLabels,
  isValidLegendAttrs,
  MAX_LEGEND_TEXT,
} from "@/lib/viz";

/**
 * A layer document's field rules: the shape each of a layer's own fields
 * must have, read from a body that may hold any of them. The layer write
 * takes a request's body through here; a layer read from elsewhere (an
 * archive's map document) is held to the same rules, so one rule set
 * admits both. What the fields mean against the layer's result (a style's
 * column references, SQL that draws geometry) is the admission's, after.
 */
export function layerFieldsFromBody(body: Record<string, unknown>): UpdateLayerFields {
  const fields: UpdateLayerFields = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string")
      throw new ApiError("invalid_request", "name must be a string.", 400);
    fields.name = body.name;
  }
  if (body.sql !== undefined) {
    if (typeof body.sql !== "string" || body.sql.trim() === "")
      throw new ApiError(
        "invalid_request",
        "sql must be a non-empty string.",
        400,
      );
    fields.sql = body.sql;
  }
  if (body.visible !== undefined) {
    if (typeof body.visible !== "boolean")
      throw new ApiError("invalid_request", "visible must be a boolean.", 400);
    fields.visible = body.visible;
  }
  if (body.style !== undefined) {
    fields.style = body.style as LayerStyle;
  }
  if (body.tooltip !== undefined) {
    if (
      body.tooltip !== null &&
      (!Array.isArray(body.tooltip) ||
        !body.tooltip.every((f) => typeof f === "string") ||
        body.tooltip.length > MAX_FIELD_LIST)
    ) {
      throw new ApiError(
        "invalid_request",
        `tooltip must be an array of up to ${MAX_FIELD_LIST} field names, or null for automatic.`,
        400,
      );
    }
    fields.tooltip = body.tooltip as string[] | null;
  }
  if (body.popup !== undefined) {
    if (
      body.popup !== null &&
      (!Array.isArray(body.popup) ||
        !body.popup.every((f) => typeof f === "string") ||
        body.popup.length > MAX_FIELD_LIST)
    ) {
      throw new ApiError(
        "invalid_request",
        `popup must be an array of up to ${MAX_FIELD_LIST} field names, or null for automatic.`,
        400,
      );
    }
    fields.popup = body.popup as string[] | null;
  }
  if (body.publishedFields !== undefined) {
    if (
      body.publishedFields !== null &&
      (!Array.isArray(body.publishedFields) ||
        !body.publishedFields.every((f) => typeof f === "string") ||
        body.publishedFields.length > MAX_FIELD_LIST)
    ) {
      throw new ApiError(
        "invalid_request",
        `publishedFields must be an array of up to ${MAX_FIELD_LIST} ` +
          "field names, or null for the derived projection. " +
          "Fields the published map needs to render are always published.",
        400,
      );
    }
    fields.publishedFields = body.publishedFields as string[] | null;
  }
  if (body.inLegend !== undefined) {
    if (typeof body.inLegend !== "boolean")
      throw new ApiError("invalid_request", "inLegend must be a boolean.", 400);
    fields.inLegend = body.inLegend;
  }
  if (body.viz !== undefined) {
    if (!isValidViz(body.viz))
      throw new ApiError(
        "invalid_request",
        'viz must describe a valid visualization: "points", "hexbin" (cellKm, aggregate), "grid" (cellKm, aggregate), "heatmap" (radiusPx, intensity, weight), "arc"/"line" (origin, dest, height, targetColor), "icon" (glyph from the curated set, optional sanitized customSvg), or "cluster" (radiusPx, color, showCounts).',
        400,
      );
    // The sanitizer is the gate for custom icon markup: whatever
    // arrives is re-sanitized here, so only its accepted output is
    // ever stored — agents and the picker get the same rules. Its
    // invalid_request wordings pass through.
    const stated = body.viz as { type?: string; customSvg?: unknown };
    if (
      stated.type === "icon" &&
      typeof stated.customSvg === "string"
    ) {
      stated.customSvg = sanitizeSvgIcon(stated.customSvg).svg;
    }
    fields.viz = body.viz;
  }
  if (body.filters !== undefined) {
    if (!isValidFilters(body.filters))
      throw new ApiError(
        "invalid_request",
        "filters must be an array of range ({field, kind:'range', min, max}) or value-set ({field, kind:'values', values}) filters.",
        400,
      );
    fields.filters = body.filters;
  }
  if (body.legendTitle !== undefined) {
    if (
      body.legendTitle !== null &&
      (typeof body.legendTitle !== "string" ||
        body.legendTitle.length > MAX_LEGEND_TEXT)
    )
      throw new ApiError(
        "invalid_request",
        "legendTitle must be a short string, or null for the layer name.",
        400,
      );
    fields.legendTitle = body.legendTitle;
  }
  if (body.legendLabels !== undefined) {
    if (body.legendLabels !== null && !isValidLegendLabels(body.legendLabels))
      throw new ApiError(
        "invalid_request",
        "legendLabels must be an array of short strings (null entries keep the automatic label), or null to reset all.",
        400,
      );
    fields.legendLabels = body.legendLabels;
  }
  if (body.legendAttrs !== undefined) {
    if (body.legendAttrs !== null && !isValidLegendAttrs(body.legendAttrs))
      throw new ApiError(
        "invalid_request",
        "legendAttrs must map legend channels (fill, stroke, radius, width) to short attribute names, or a null value to hide that channel's attribute line; null for the whole field is all-automatic.",
        400,
      );
    fields.legendAttrs = body.legendAttrs;
  }
  return fields;
}
