import { jsonBytes } from "@/lib/query/result-budget";
import { featureTags, shapeProperties, type BuiltFeature } from "./geometry";

/**
 * Exact sizes of a preview feature, counted without building its JSON. A
 * preview feature carries its OSM tags as one JSON text inside a string
 * property, so a tag's characters are escaped twice, once in that text
 * and again in the answer: a quote or a backslash becomes four bytes, a
 * named control character three and any other control character seven.
 */

/** The bytes a string adds to the tags text, counted as the answer holds
 * that text: its two quotes and every character escaped twice. */
function stringInText(text: string): number {
  let bytes = 4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34 || c === 92) bytes += 4;
    else if (c === 8 || c === 9 || c === 10 || c === 12 || c === 13) bytes += 3;
    else if (c < 32) bytes += 7;
    else if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else if (c >= 0xd800 && c <= 0xdfff) bytes += 7;
    else bytes += 3;
  }
  return bytes;
}

/**
 * The bytes the JSON text of a value adds inside a string of the answer,
 * the string's own quotes excluded: what serializing the value to text and
 * that text into the answer would cost. It follows the serialization of
 * values a parsed response can hold: an object's own enumerable names in
 * order, an array's items, a number's shortest spelling or null.
 */
export function textInStringBytes(value: unknown): number {
  if (value === null || value === undefined) return 4;
  switch (typeof value) {
    case "string":
      return stringInText(value);
    case "number":
      return Number.isFinite(value) ? String(value).length : 4;
    case "boolean":
      return value ? 4 : 5;
    case "object": {
      if (Array.isArray(value)) {
        let bytes = 2 + Math.max(0, value.length - 1);
        for (const item of value) bytes += item === undefined || typeof item === "function" || typeof item === "symbol" ? 4 : textInStringBytes(item);
        return bytes;
      }
      let bytes = 2;
      let count = 0;
      for (const key of Object.keys(value)) {
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
        bytes += (count++ ? 1 : 0) + stringInText(key) + 1 + textInStringBytes(item);
      }
      return bytes;
    }
    default:
      return 4;
  }
}

/** A feature's shaped properties with its tags text left empty, so that a
 * caller can add the tags' own count. */
export function propertiesWithoutTags(feature: BuiltFeature, promoted: string[]): Record<string, string | null> {
  return shapeProperties(feature, promoted, "");
}

/**
 * The exact UTF-8 size of the feature a preview would carry for this
 * built feature, as serializing its shaped form measures it, without
 * serializing its tags.
 */
export function featureBytes(feature: BuiltFeature, promoted: string[]): number {
  return jsonBytes({ type: "Feature", properties: propertiesWithoutTags(feature, promoted), geometry: feature.geometry })
    + textInStringBytes(featureTags(feature));
}

/** The size of one coordinate pair as a feature serializes it. */
export function pairBytes(lon: number, lat: number): number {
  return 3 + numberBytes(lon) + numberBytes(lat);
}

function numberBytes(value: number): number {
  return Number.isFinite(value) ? String(value).length : 4;
}
