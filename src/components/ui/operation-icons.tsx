import tone from "./operation-icons.module.css";

/**
 * The operation pictograms (the two-tone set): one distinct drawing per
 * catalog verb, keyed by the `symbol` the catalog serves, transliterated
 * line for line from the named reference on its 40-unit grid, with the
 * tone grammar in operation-icons.module.css. One hue from currentColor,
 * so every surface's dress applies its own colour.
 *
 * The registry is exported so the catalog sweep can hold both directions:
 * every served symbol resolves to a glyph, and a glyph nobody serves is
 * dead weight a reviewer should see. The geometry glyphs and the Tools
 * door below keep their own grid and artwork (closed surfaces).
 */

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** The set's wrapper: the reference's grid; the tone classes come
 * from the module stylesheet; sized by each surface's own rules. */
function TwoTone({ children }: { children: React.ReactNode }) {
  return (
    <svg width="20" height="20" viewBox="0 0 40 40" fill="none" className={tone.g2} aria-hidden="true">
      {children}
    </svg>
  );
}

export const OPERATION_GLYPHS: Record<string, () => React.ReactNode> = {
  // Data
  // sql_step
  code: () => (
    <TwoTone>
      <rect className={tone.ws} x="4" y="7" width="32" height="26" rx="4"/>
      <path d="M11 15l5 4.5L11 24"/>
      <path d="M19 25h9"/>
    </TwoTone>
  ),
  // filter_rows
  filter: () => (
    <TwoTone>
      <path className={tone.ws} d="M6 8h28L23.5 21v10l-7 3V21L6 8Z"/>
      <path d="M12 13h16"/>
      <path d="M15.5 17.5h9"/>
    </TwoTone>
  ),
  // join_by_key
  key: () => (
    <TwoTone>
      <rect className={tone.ws} x="3" y="9" width="16" height="22" rx="3"/>
      <rect className={tone.ws} x="21" y="9" width="16" height="22" rx="3"/>
      <path className={tone.f} d="M7 15h8M25 15h8M7 25h8M25 25h8"/>
      <rect className={tone.s} x="6" y="18.5" width="28" height="3.2" rx="1.6"/>
    </TwoTone>
  ),
  // geocode_addresses
  pin: () => (
    <TwoTone>
      <path d="M4 12h11M4 18h8M4 24h11"/>
      <path d="M17.5 18h5.5M20.5 15.5l2.5 2.5-2.5 2.5"/>
      <path className={tone.ws} d="M31 35c-5-6.2-7.5-10-7.5-14a7.5 7.5 0 0 1 15 0c0 4-2.5 7.8-7.5 14Z"/>
      <circle className={tone.s} cx="31" cy="20.5" r="2.3"/>
    </TwoTone>
  ),
  // isochrone
  clock: () => (
    <TwoTone>
      <path className={tone.ws} d="M19 9c8 0 13.5 6 14 12.5S27 34 19 34 5 29 5.5 21 11 9 19 9Z"/>
      <path className={tone.ws} d="M19 15c4.5 0 7 3 7 6.5S23.5 28 19 28s-7-3-7-6.5 2.5-6.5 7-6.5Z"/>
      <circle className={tone.s} cx="19" cy="21.5" r="2.3"/>
      <circle cx="33" cy="8" r="5"/>
      <path d="M33 5.2V8l1.9 1.4"/>
    </TwoTone>
  ),
  // Overlay
  // spatial_join
  overlay: () => (
    <TwoTone>
      <rect className={tone.ws} x="5" y="7" width="20" height="20" rx="4"/>
      <circle cx="26" cy="25" r="10"/>
      <circle className={tone.s} cx="19" cy="20" r="2"/>
      <circle className={tone.s} cx="23" cy="17.5" r="2"/>
      <circle className={tone.s} cx="20.5" cy="24.5" r="2"/>
    </TwoTone>
  ),
  // clip
  clip: () => (
    <TwoTone>
      <rect x="5" y="7" width="20" height="20" rx="4"/>
      <circle cx="26" cy="25" r="10"/>
      <path className={tone.s} d="M25 15.05A10 10 0 0 0 16.2 27H25Z"/>
    </TwoTone>
  ),
  // difference
  difference: () => (
    <TwoTone>
      <rect className={tone.ws} x="5" y="7" width="20" height="20" rx="4"/>
      <circle className={tone.d} cx="26" cy="25" r="10"/>
      <path d="M18.5 18.5l6 6M17 23.5l3.5 3.5M22.5 16l2.5 2.5"/>
    </TwoTone>
  ),
  // union
  union: () => (
    <TwoTone>
      <rect className={tone.ws} x="5" y="7" width="20" height="20" rx="4"/>
      <circle className={tone.ws} cx="26" cy="25" r="10"/>
      <path className={tone.s} d="M25 15.05A10 10 0 0 0 16.2 27H25Z"/>
    </TwoTone>
  ),
  // Proximity
  // buffer
  buffer: () => (
    <TwoTone>
      <path className={`${tone.ws} ${tone.d}`} d="M14.1 32.9L34.1 20.9A8 8 0 0 0 25.9 7.1L5.9 19.1A8 8 0 0 0 14.1 32.9Z"/>
      <path d="M10 26L30 14"/>
      <circle className={tone.s} cx="10" cy="26" r="2"/>
      <circle className={tone.s} cx="30" cy="14" r="2"/>
    </TwoTone>
  ),
  // nearest_join
  nearest: () => (
    <TwoTone>
      <path className={`${tone.f} ${tone.d}`} d="M9 20L33 20M9 20L27 29"/>
      <path d="M9 20L26 12"/>
      <path d="M22.5 10.5L26 12l-1 3.6"/>
      <circle className={tone.s} cx="9" cy="20" r="3"/>
      <circle className={tone.s} cx="26" cy="12" r="2.6"/>
      <circle cx="33" cy="20" r="2.4"/>
      <circle cx="27" cy="29" r="2.4"/>
    </TwoTone>
  ),
  // filter_by_location
  filter_location: () => (
    <TwoTone>
      <path className={tone.ws} d="M6 12l10-6 16 4 2 14-9 12-14-2-5-12Z"/>
      <circle className={tone.s} cx="14" cy="14" r="2.1"/>
      <circle className={tone.s} cx="25" cy="13" r="2.1"/>
      <circle className={tone.s} cx="20" cy="21" r="2.1"/>
      <circle className={tone.s} cx="16" cy="27" r="2.1"/>
      <circle className={tone.f} cx="34" cy="33" r="2.3"/>
      <circle className={tone.f} cx="6" cy="33" r="2.3"/>
    </TwoTone>
  ),
  // Geometry
  // measure_columns
  ruler: () => (
    <TwoTone>
      <path className={tone.ws} d="M6 23V11l14-5 14 5v12Z"/>
      <rect x="6" y="26" width="28" height="7" rx="1.5"/>
      <path d="M11 26v3M16 26v4.5M21 26v3M26 26v4.5M31 26v3"/>
    </TwoTone>
  ),
  // centroid
  centroid: () => (
    <TwoTone>
      <path className={tone.ws} d="M7 10l14-5 12 8-2 15-13 6-11-9Z"/>
      <path d="M20 12.5v4.5M20 23v4.5M12.5 20H17M23 20h4.5"/>
      <circle className={tone.s} cx="20" cy="20" r="2.5"/>
    </TwoTone>
  ),
  // convex_hull
  hull: () => (
    <TwoTone>
      <path className={tone.ws} d="M10 12L28 8l6 14-10 11-15-5Z"/>
      <circle className={tone.s} cx="10" cy="12" r="2.2"/>
      <circle className={tone.s} cx="28" cy="8" r="2.2"/>
      <circle className={tone.s} cx="34" cy="22" r="2.2"/>
      <circle className={tone.s} cx="24" cy="33" r="2.2"/>
      <circle className={tone.s} cx="9" cy="28" r="2.2"/>
      <circle cx="18" cy="18" r="1.8"/>
      <circle cx="24" cy="20" r="1.8"/>
      <circle cx="16" cy="25" r="1.8"/>
    </TwoTone>
  ),
  // simplify
  simplify: () => (
    <TwoTone>
      <path className={tone.f} d="M4 14l4-4 4 5 4-6 5 6 4-4 4 5 4-5 3 3"/>
      <circle className={`${tone.s} ${tone.f}`} cx="8" cy="10" r="1.4"/>
      <circle className={`${tone.s} ${tone.f}`} cx="12" cy="15" r="1.4"/>
      <circle className={`${tone.s} ${tone.f}`} cx="16" cy="9" r="1.4"/>
      <circle className={`${tone.s} ${tone.f}`} cx="21" cy="15" r="1.4"/>
      <circle className={`${tone.s} ${tone.f}`} cx="25" cy="11" r="1.4"/>
      <circle className={`${tone.s} ${tone.f}`} cx="29" cy="16" r="1.4"/>
      <circle className={`${tone.s} ${tone.f}`} cx="33" cy="11" r="1.4"/>
      <path d="M4 30l9-6 10 3 13-7"/>
      <circle className={tone.s} cx="4" cy="30" r="2.2"/>
      <circle className={tone.s} cx="13" cy="24" r="2.2"/>
      <circle className={tone.s} cx="23" cy="27" r="2.2"/>
      <circle className={tone.s} cx="36" cy="20" r="2.2"/>
    </TwoTone>
  ),
  // Aggregation
  // dissolve
  dissolve: () => (
    <TwoTone>
      <rect className={tone.ws} x="6" y="8" width="28" height="24" rx="4"/>
      <path className={`${tone.f} ${tone.d}`} d="M20 8v24M6 20h28"/>
    </TwoTone>
  ),
  // group_summarize
  summarize: () => (
    <TwoTone>
      <rect className={tone.w} x="4" y="9" width="14" height="4" rx="2"/>
      <rect className={tone.w} x="4" y="18" width="14" height="4" rx="2"/>
      <rect className={tone.w} x="4" y="27" width="14" height="4" rx="2"/>
      <path d="M20.5 9c2.5 0 3 2 3 5.5s0.5 5.5 3 5.5c-2.5 0-3 2-3 5.5s-0.5 5.5-3 5.5"/>
      <path d="M29 11h8l-5.5 9 5.5 9h-8"/>
    </TwoTone>
  ),
  // Statistics
  // h3_cell
  hex: () => (
    <TwoTone>
      <path className={tone.d} d="M20 7l11.3 6.5v13L20 33 8.7 26.5v-13Z"/>
      <path className={tone.f} d="M8.7 13.5L3 10M8.7 26.5L3 30M31.3 13.5L37 10M31.3 26.5L37 30"/>
      <circle className={tone.s} cx="16" cy="22" r="3"/>
      <path d="M18.5 19.5L23 15"/>
      <rect className={tone.ws} x="22" y="9.5" width="12" height="7" rx="2"/>
      <path d="M25 13h6"/>
    </TwoTone>
  ),
  // hotspot
  stats: () => (
    <TwoTone>
      <path className={tone.s} d="M20 4l6.9 4v8L20 20l-6.9-4V8Z"/>
      <path className={tone.ws} d="M13 16l6.9 4v8L13 32l-6.9-4v-8Z"/>
      <path className={tone.ws} d="M27 16l6.9 4v8L27 32l-6.9-4v-8Z"/>
    </TwoTone>
  ),
  // cluster_by_distance
  points: () => (
    <TwoTone>
      <circle className={tone.d} cx="13" cy="15" r="9"/>
      <circle className={tone.d} cx="27" cy="26" r="9"/>
      <circle className={tone.s} cx="10" cy="12" r="2.2"/>
      <circle className={tone.s} cx="16" cy="14" r="2.2"/>
      <circle className={tone.s} cx="12" cy="18" r="2.2"/>
      <circle className={tone.s} cx="25" cy="24" r="2.2"/>
      <circle className={tone.s} cx="30" cy="28" r="2.2"/>
      <circle className={tone.s} cx="26" cy="30" r="2.2"/>
      <circle cx="33" cy="8" r="2.4"/>
    </TwoTone>
  ),
};

/** A served symbol's glyph, with the magnifier-over-rings mark — redrawn
 * in the set's grammar — as the honest fallback for a symbol this build
 * has not drawn yet: present, never blank. */
export function OperationGlyph({ symbol }: { symbol: string }) {
  const draw = OPERATION_GLYPHS[symbol];
  if (draw) return <>{draw()}</>;
  return (
    <TwoTone>
      <circle className={tone.ws} cx="18" cy="18" r="6" />
      <circle className={tone.d} cx="18" cy="18" r="13" />
      <path d="M27.5 27.5 36 36" />
    </TwoTone>
  );
}

/** The Tools door's own mark: shared here so no control hand-draws
 * it — the shipped magnifier-over-rings from the approved prototype. */
export function ToolsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.2" />
      <circle cx="12" cy="12" r="8.2" strokeDasharray="3 2.5" />
      <path d="M14.4 14.4 20 20" />
    </svg>
  );
}

/** The table list's geometry marks: the design's dotted points, the
 * open polygon, the line, and the plain table for a geometry-less dataset. */
export function GeometryGlyph({
  geometryType,
}: {
  geometryType: string | null;
}) {
  const kind = geometryType?.toUpperCase() ?? null;
  if (kind === null) {
    return (
      <Glyph>
        <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
        <path d="M3.5 10h17M9.5 10v9.5" />
      </Glyph>
    );
  }
  if (kind.includes("POLYGON")) {
    return (
      <Glyph>
        <path d="M12 3.5 19.5 9l-3 9.5h-9L4.5 9 12 3.5Z" />
      </Glyph>
    );
  }
  if (kind.includes("LINE")) {
    return (
      <Glyph>
        <path d="M4 18 9 8l4 5 7-9" />
      </Glyph>
    );
  }
  if (kind.includes("POINT")) {
    return (
      <Glyph>
        <g fill="currentColor" stroke="none">
          <circle cx="7" cy="15.5" r="2.4" />
          <circle cx="14.5" cy="7.5" r="2.4" />
          <circle cx="17" cy="16.5" r="1.9" />
        </g>
      </Glyph>
    );
  }
  // A spatial type this build cannot classify — GEOMETRY, MIXED, a
  // collection — draws a mixed mark rather than visually claiming points
  // beside facts that say otherwise (review).
  return (
    <Glyph>
      <circle cx="7" cy="7" r="2" fill="currentColor" stroke="none" />
      <path d="M4 18l5-6 4 3" />
      <path d="M15 5l5 3-1.5 6-5-1L15 5Z" />
    </Glyph>
  );
}
