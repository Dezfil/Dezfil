/**
 * The application's icon set (moved app-level and extended): inline SVGs
 * on currentColor, one consistent style — no icon dependency, no unicode
 * glyph soup.
 *
 * Three rendered sizes: the **action** tier at
 * 13px/2.0 for icon-only actions, the **chrome** tier normally at 16px
 * with a 1.6–2.0 stroke for the builder's header and stage buttons, and
 * the **illustrative** tier at 20px/1.5 for visualization tiles. The
 * stage compass is chrome's named exception: a 22px filled directional
 * mark. The rulebook had no name for these shipped shapes; preserved them
 * rather than changing toolbar icons as a side effect, and doc 07 closed
 * the gap by describing both shapes explicitly.
 */

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** The layer card's source action: a layer is its SQL. */
export function CodeIcon() {
  return (
    <Svg>
      <path d="m8 9-4 3 4 3M16 9l4 3-4 3" />
    </Svg>
  );
}

export function SignOutIcon() {
  return <Svg><path d="M14 4H5.5v16H14M10 12h11M17.5 8.5 21 12l-3.5 3.5" /></Svg>;
}

export function PencilIcon() {
  return (
    <Svg>
      <path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </Svg>
  );
}

/** The one fit picture: the layer row's zoom-to-layer and the
 * toolbar's whole-map fit draw the same target glyph — one picture for
 * one idea, ruled in the field and superseding a compass star. The
 * two exports differ only in tier: action-sized here, chrome-sized
 * in FitIcon below. */
const targetGlyph = (
  <>
    <circle cx="12" cy="12" r="6" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </>
);

export function TargetIcon() {
  return <Svg>{targetGlyph}</Svg>;
}

/** The canvas lock: closed, and open for the unlocked state. */
export function LockIcon() {
  return (
    <Svg>
      <rect x="5" y="11" width="14" height="10" rx="2.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Svg>
  );
}

export function UnlockIcon() {
  return (
    <Svg>
      <rect x="5" y="11" width="14" height="10" rx="2.5" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2" />
    </Svg>
  );
}

export function CopyIcon() {
  return (
    <Svg>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  );
}

export function TrashIcon() {
  return (
    <Svg>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  );
}

export function EyeIcon() {
  return (
    <Svg>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function EyeOffIcon() {
  return (
    <Svg>
      <path d="M9.9 4.24A10.6 10.6 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M6.61 6.61A13.5 13.5 0 0 0 1 12s4 8 11 8a10.9 10.9 0 0 0 5.39-1.61" />
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M2 2l20 20" />
    </Svg>
  );
}

/** The assistant's Stop: a filled
 * rounded square in the Send slot's register. */
export function StopIcon() {
  return (
    <Svg>
      <rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function CheckIcon() {
  return (
    <Svg>
      <path d="M20 6L9 17l-5-5" />
    </Svg>
  );
}

/** Ending a conversation (item 6): page 05's broom, at the action tier. */
export function BroomIcon() {
  return (
    <Svg>
      <path d="M19.4 4.6l-6.7 6.7" />
      <path d="M10.6 10.6l2.8 2.8-3.2 5.3-4.9-4.9z" />
      <path d="M9 11.6l3.4 3.4" />
    </Svg>
  );
}

export function XIcon() {
  return (
    <Svg>
      <path d="M18 6L6 18M6 6l12 12" />
    </Svg>
  );
}

export function TimelineIcon() {
  return (
    <Svg>
      <path d="M3 19h18M7 19v-6M12 19V6M17 19v-9" />
    </Svg>
  );
}

export function PlayIcon() {
  return (
    <Svg>
      <path d="M7 4.5l12 7.5-12 7.5z" />
    </Svg>
  );
}

export function PauseIcon() {
  return (
    <Svg>
      <path d="M9 5v14M15 5v14" />
    </Svg>
  );
}

export function SearchIcon() {
  return (
    <Svg>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </Svg>
  );
}

export function GripIcon() {
  return (
    <Svg>
      <circle cx="9" cy="5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9" cy="19" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="19" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function ChevronIcon() {
  return (
    <Svg>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  );
}

/** Zoom in / zoom out — the drawn replacements for the stage stack's ＋ and
 * − characters, whose glyph class is banned in UI chrome. */
export function PlusIcon() {
  return (
    <Svg>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

/** A move into this project: the arrow the recent row wears when a map
 * or workflow leaves another project. */
export function MoveIcon() {
  return (
    <Svg>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Svg>
  );
}

export function MinusIcon() {
  return (
    <Svg>
      <path d="M5 12h14" />
    </Svg>
  );
}

/** The overflow-menu mark — the drawn replacement for the ⋮ character. */
export function MoreIcon() {
  return (
    <Svg>
      <circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** A filled status dot — the drawn replacement for the ● character. */
export function DotIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** The audience mark: who a published link reaches. */
export function GlobeIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" />
    </Svg>
  );
}

/** Leaves the app — the drawn replacement for the ↗ character. */
export function ExternalIcon() {
  return (
    <Svg>
      <path d="M14 4h6v6M20 4l-8 8" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </Svg>
  );
}

/** Discloses collapsed technical detail — a chevron that points right when
 * closed; the caller rotates it. */
export function CaretIcon() {
  return (
    <Svg>
      <path d="M9 6l6 6-6 6" />
    </Svg>
  );
}

/* ── The chrome tier ───────────────────────────────────────────────────
   The builder's header and stage buttons, absorbed from MapBuilder's
   inline dialect. Size and stroke are the ones those buttons have
   always rendered; only their home changes. */

function ChromeSvg({
  children,
  strokeWidth = 1.8,
  className,
  style,
}: {
  children: React.ReactNode;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** The workflow canvas's state badges and header action: run
 * again (stale, output deleted), a warning (cannot run, run failed), and
 * arrange by dependency. Action tier; the badge scales them by CSS. */
export function RerunIcon() {
  return (
    <Svg>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.5 3.5v5.2h-5.2" />
    </Svg>
  );
}

export function WarnIcon() {
  return (
    <Svg>
      <path d="M12 3.6 22.2 20.4H1.8L12 3.6Z" />
      <path d="M12 10v4.2M12 17.4h.01" />
    </Svg>
  );
}

export function ArrangeIcon() {
  return (
    <ChromeSvg>
      <rect x="3" y="4" width="6" height="6" rx="1.5" />
      <rect x="15" y="8" width="6" height="6" rx="1.5" />
      <rect x="3" y="14" width="6" height="6" rx="1.5" />
      <path d="M9 7h3.5a2 2 0 0 1 2 2v2M9 17h3.5a2 2 0 0 0 2-2v-2" />
    </ChromeSvg>
  );
}

export function UndoIcon() {
  return (
    <ChromeSvg>
      <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />
    </ChromeSvg>
  );
}

export function RedoIcon() {
  return (
    <ChromeSvg>
      <path d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" />
    </ChromeSvg>
  );
}

/** The canvas stage's Undo and Redo: the
 * header pair's arrow over a two-tone wash of the loop it closes, so the
 * stack's own pair reads at a glance as a step taken back rather than a
 * plain arrow. The wash is currentColor at the reference's 0.22. */
/** The minimap toggle (word after): a
 * canvas with the small framed map in its corner, in the stage's tones. */
export function MinimapIcon() {
  return (
    <ChromeSvg>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <rect x="12.5" y="12" width="6.5" height="5.5" rx="1" fill="currentColor" stroke="none" opacity="0.22" />
      <rect x="12.5" y="12" width="6.5" height="5.5" rx="1" />
    </ChromeSvg>
  );
}

export function StageUndoIcon() {
  return (
    <ChromeSvg>
      <path d="M14 9a6 6 0 0 1 0 12Z" fill="currentColor" stroke="none" opacity="0.22" />
      <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />
    </ChromeSvg>
  );
}

export function StageRedoIcon() {
  return (
    <ChromeSvg>
      <path d="M10 9a6 6 0 0 0 0 12Z" fill="currentColor" stroke="none" opacity="0.22" />
      <path d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" />
    </ChromeSvg>
  );
}

/** Fit to data: the target glyph at chrome tier — the same picture as
 * the layer row's TargetIcon, by a field ruling. */
export function FitIcon() {
  return <ChromeSvg>{targetGlyph}</ChromeSvg>;
}

/** A note's Duplicate: two sheets, one behind the other. */
export function DuplicateIcon() {
  return (
    <Svg>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 5H6a2 2 0 0 0-2 2v9" />
    </Svg>
  );
}

/** The canvas's note tool: a sheet with a turned corner and
 * two lines of text, the stage stack's own tier. */
/** A statement's mark: the dataset preview's refusal is said, not
 * whispered. A circle with its stroke, not a triangle: nothing went wrong. */
export function InfoIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.6h.01" />
    </Svg>
  );
}
export function NoteIcon() {
  return (
    <ChromeSvg>
      <path d="M5 4h10l4 4v12H5z" />
      <path d="M15 4v4h4" />
      <path d="M8.5 12.5h7M8.5 16h5" />
    </ChromeSvg>
  );
}

/** The basemap picker's entry: stacked sheets, the standard
 * cartographic sign for "which map underneath". */
export function LayersIcon() {
  return (
    <ChromeSvg>
      <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z" />
      <path d="M3 12.5 12 17l9-4.5" />
      <path d="M3 17 12 21.5 21 17" />
    </ChromeSvg>
  );
}

/** The published viewer's theme control. The same crescent
 * and sun the workspace toggle draws, so one idea has one picture. */
export function MoonIcon() {
  return (
    <ChromeSvg>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </ChromeSvg>
  );
}

export function SunIcon() {
  return (
    <ChromeSvg>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </ChromeSvg>
  );
}

export function PreviewIcon() {
  return (
    <ChromeSvg>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
      <circle cx="12" cy="12" r="3" />
    </ChromeSvg>
  );
}

/** The stage compass. A bold full-height needle whose north half is solid;
 * the caller counter-rotates it with the map bearing. */
export function CompassNeedleIcon({ bearing }: { bearing: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      style={{ transform: `rotate(${-bearing}deg)` }}
    >
      <path d="M12 2 L15.8 12 L8.2 12 Z" fill="currentColor" />
      <path d="M12 22 L8.2 12 L15.8 12 Z" fill="currentColor" opacity="0.45" />
    </svg>
  );
}

/** The isometric cube: the 3D tilt mark. */
export function TiltIcon() {
  return (
    <ChromeSvg strokeWidth={1.6}>
      <path d="M12 3.5 L19.5 7.75 L19.5 16.25 L12 20.5 L4.5 16.25 L4.5 7.75 Z" />
      <path d="M4.5 7.75 L12 12 L19.5 7.75 M12 12 L12 20.5" />
    </ChromeSvg>
  );
}

export function ExpandIcon({ className }: { className?: string }) {
  return (
    <ChromeSvg className={className} strokeWidth={1.9}>
      <path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6" />
    </ChromeSvg>
  );
}

export function CompressIcon({ className }: { className?: string }) {
  return (
    <ChromeSvg className={className} strokeWidth={1.9}>
      <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
    </ChromeSvg>
  );
}

/** The assistant's two sparkles. */
export function SparkleIcon() {
  return (
    <ChromeSvg strokeWidth={1.7}>
      <path d="M12 3l1.9 5.6L20 10l-6.1 1.4L12 17l-1.9-5.6L4 10l6.1-1.4L12 3Z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" />
    </ChromeSvg>
  );
}

/** Visualization-tile glyphs: larger than the action icons,
 * lighter stroke — the tile carries them with a label beneath. */
function VizSvg({ children }: { children: React.ReactNode }) {
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

export function VizPointsIcon() {
  return (
    <VizSvg>
      <circle cx="6" cy="7" r="1.8" />
      <circle cx="13" cy="5" r="1.8" />
      <circle cx="18" cy="10" r="1.8" />
      <circle cx="8" cy="14" r="1.8" />
      <circle cx="15" cy="17" r="1.8" />
      <circle cx="5" cy="19" r="1.8" />
    </VizSvg>
  );
}

export function VizPathIcon() {
  return (
    <VizSvg>
      <path d="M4 18 9 9.5l5 4L20 5" />
      <circle cx="4" cy="18" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="20" cy="5" r="1.6" fill="currentColor" stroke="none" />
    </VizSvg>
  );
}

export function VizPolygonIcon() {
  return (
    <VizSvg>
      <path d="M12 3.5 19.5 9l-3 9.5h-9L4.5 9 12 3.5Z" />
    </VizSvg>
  );
}

export function VizArcIcon() {
  return (
    <VizSvg>
      <path d="M4.5 18.5Q12 4.5 19.5 18.5" />
      <circle cx="4.5" cy="18.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="19.5" cy="18.5" r="1.5" fill="currentColor" stroke="none" />
    </VizSvg>
  );
}

export function VizLineIcon() {
  return (
    <VizSvg>
      <path d="M5.5 18.5 18.5 5.5" />
      <circle cx="5.5" cy="18.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="5.5" r="1.5" fill="currentColor" stroke="none" />
    </VizSvg>
  );
}

export function VizHexbinIcon() {
  return (
    <VizSvg>
      <path d="M8 3.5 4 6v5l4 2.5L12 11V6L8 3.5Z" />
      <path d="M16 10.5l-4 2.5v5l4 2.5 4-2.5v-5l-4-2.5Z" />
    </VizSvg>
  );
}

export function VizGridIcon() {
  return (
    <VizSvg>
      <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
    </VizSvg>
  );
}

export function VizClusterIcon() {
  return (
    <VizSvg>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </VizSvg>
  );
}

export function VizIconIcon() {
  return (
    <VizSvg>
      <path d="M12 21.5c-4.6-6-7-9.4-7-12.8a7 7 0 1 1 14 0c0 3.4-2.4 6.8-7 12.8Z" />
      <circle cx="12" cy="8.9" r="2.2" />
    </VizSvg>
  );
}

export function VizHeatmapIcon() {
  return (
    <VizSvg>
      <path d="M12 3c2 4 6 5.5 6 10a6 6 0 1 1-12 0c0-2.5 1.2-4 2.5-5.8C9.8 5.5 11 4.5 12 3Z" />
      <path d="M12 12c1 1.6 2 2.3 2 4a2 2 0 1 1-4 0c0-1.7 1-2.4 2-4Z" />
    </VizSvg>
  );
}

/** Analysis: a flask, for the layer card's Analyze… door. */
export function AnalyzeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        d="M6.5 2v4.2L3.2 12a1.6 1.6 0 0 0 1.4 2.4h6.8A1.6 1.6 0 0 0 12.8 12L9.5 6.2V2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M5.5 2h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M4.7 10.4h6.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** Back to the list a face came from. */
export function BackIcon() {
  return (
    <Svg>
      <path d="M15 5l-7 7 7 7" />
    </Svg>
  );
}

/** Select mode's pick cursor. */
export function CursorIcon() {
  return (
    <Svg>
      <path d="M5 3l7 17 2.2-6.8L21 11 5 3Z" />
    </Svg>
  );
}

/** The draw dock's hand — explicit pan/zoom. */
export function HandIcon() {
  return (
    <Svg>
      <path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V13" />
      <path d="M17 13v-1a1.5 1.5 0 0 1 3 .5l-1.2 4.6A6 6 0 0 1 13 21.5h-1a6 6 0 0 1-4.6-2.1L4 15.6a1.6 1.6 0 0 1 2.4-2.1L8 15.2" />
    </Svg>
  );
}

/** The point tool: a click drops a feature. */
export function DrawPointIcon() {
  return (
    <Svg>
      <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.5" />
    </Svg>
  );
}

/** The line tool: vertices with endpoint marks. */
export function DrawLineIcon() {
  return (
    <Svg>
      <path d="M6.5 17.5 17.5 6.5" />
      <circle cx="5.5" cy="18.5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="5.5" r="1.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** The rectangle tool. */
export function DrawRectangleIcon() {
  return (
    <Svg>
      <rect x="4" y="6" width="16" height="12" rx="2" />
    </Svg>
  );
}

/** The circle tool: drawn by ground-metre radius. */
export function DrawCircleIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="8" />
    </Svg>
  );
}

/** The freehand tool: always closes into a polygon. */
export function DrawFreehandIcon() {
  return (
    <Svg>
      <path d="M3 17c3-9 5 3 8-6 2.5-7.5 4 5 10-4" />
    </Svg>
  );
}

/** The SQL page's Sources tab (the rename of Tables): the same
 * cylinder the workflows canvas pane wears, so the two panes read as one. */
export function DatabaseIcon() {
  return (
    <Svg>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
      <path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
    </Svg>
  );
}

/** The SQL page's History tab: a clock with a backward arrow, not the
 * isochrone's plain clock, so the two never share a symbol. */
export function HistoryIcon() {
  return (
    <Svg>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3.5 3.5v4.5H8" />
      <path d="M12 7.5V12l3 2" />
    </Svg>
  );
}

/* The set-geometry surface (03 P and the doors of 01/04) ---- */

/** The door's mark: a place pin. */
export function GeoPinIcon() {
  return (
    <Svg>
      <path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10Z" />
      <circle cx="12" cy="11" r="2.2" />
    </Svg>
  );
}

/** The pair's swap: two arrows exchanging places. */
export function SwapIcon() {
  return (
    <Svg>
      <path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" />
    </Svg>
  );
}

export function FormatPairIcon() {
  return (
    <Svg>
      <path d="M4 20V4M4 20h16" />
      <circle cx="10" cy="13" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="15" cy="8" r="1.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function FormatWktIcon() {
  return (
    <Svg>
      <path d="M4 7h4M4 12h7M4 17h5" />
      <path d="M13 8c3 0 3 8 7 8" />
    </Svg>
  );
}

export function FormatJsonIcon() {
  return (
    <Svg>
      <path d="M8 4c-2 0-3 1-3 3v3c0 1-1 2-2 2 1 0 2 1 2 2v3c0 2 1 3 3 3M16 4c2 0 3 1 3 3v3c0 1 1 2 2 2-1 0-2 1-2 2v3c0 2-1 3-3 3" />
    </Svg>
  );
}

export function FormatWkbIcon() {
  return (
    <Svg>
      <path d="M4 8h4v8H4zM10 8h4v8h-4zM16 8h4v8h-4z" />
    </Svg>
  );
}

export function FormatH3Icon() {
  return (
    <Svg>
      <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9Z" />
    </Svg>
  );
}

/* The assistant's "talking about" chips and its actions. The map
   and workflow glyphs are the rail's own (NavLinks), so the chip
   names a section with the section's picture. */

export function MapIcon() {
  return (
    <Svg>
      <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6ZM9 3v15M15 6v15" />
    </Svg>
  );
}

export function FlowIcon() {
  return (
    <Svg>
      <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="14" y="14" width="6.5" height="6.5" rx="1.5" />
      <path d="M10 6.75h4.75a2 2 0 0 1 2 2V14M14 17.25H9.25a2 2 0 0 1-2-2V10" />
    </Svg>
  );
}

/** A workflow node: the Badge tile's outline. */
export function NodeIcon() {
  return (
    <Svg>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M4 12h16" />
    </Svg>
  );
}

/** A run: play in a ring, distinct from the timeline's bare play. */
export function RunIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8l5 4-5 4z" />
    </Svg>
  );
}

/** A result table. */
export function ResultIcon() {
  return (
    <Svg>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M9 10v10" />
    </Svg>
  );
}

/** Explain this node: a question in a ring. */
export function ExplainIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.2" />
      <path d="M12 17v.5" />
    </Svg>
  );
}

/** Diagnose the last run: a pulse line. */
export function DiagnoseIcon() {
  return (
    <Svg>
      <path d="M3 12h4l2-5 4 10 2-5h6" />
    </Svg>
  );
}

/** Insert into editor: down onto the line. */
export function InsertIcon() {
  return (
    <Svg>
      <path d="M12 4v12" />
      <path d="M7 11l5 5 5-5" />
      <path d="M4 20h16" />
    </Svg>
  );
}

/** People: the mark of a project shared between people. Never the
 * three-node share glyph, which already says "also in another project". */
export function PeopleIcon() {
  return (
    <Svg>
      <circle cx="9.2" cy="8.4" r="3.2" />
      <path d="M3.2 19.6c.7-3.1 3.1-5 6-5s5.3 1.9 6 5M15.4 5.6a3.2 3.2 0 0 1 0 5.6M17.6 14.9c1.7.6 3 2.2 3.5 4.7" />
    </Svg>
  );
}

/** A database connection: the rail's Connections glyph at the action
 * tier, where a line names something a connection feeds. */
export function PlugIcon() {
  return (
    <Svg>
      <path d="M9 3v4M15 3v4M7 7h10v3.5a5 5 0 0 1-10 0V7ZM12 15.5V21" />
    </Svg>
  );
}

/** The recorded change time, shared by document heads. */
export function ClockIcon() {
  return <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
}

/* The Settings column: one chrome-tier glyph per tab, drawn on the
   rail's stroke so the column reads as the rail's sibling. */

export function PersonIcon() {
  return <ChromeSvg strokeWidth={1.7}><circle cx="12" cy="8" r="3.6" /><path d="M5 20.2c.8-3.6 3.6-5.7 7-5.7s6.2 2.1 7 5.7" /></ChromeSvg>;
}

export function KeyIcon() {
  return <ChromeSvg strokeWidth={1.7}><path d="m21 2-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" /></ChromeSvg>;
}

export function SlidersIcon() {
  return <ChromeSvg strokeWidth={1.7}><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></ChromeSvg>;
}

/** The Appearance tab: a window and its panes. */
export function LookIcon() {
  return <ChromeSvg strokeWidth={1.7}><rect x="3" y="3" width="18" height="18" rx="2.5" /><path d="M3 9h18M9 21V9" /></ChromeSvg>;
}

export function GaugeIcon() {
  return <ChromeSvg strokeWidth={1.7}><path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /></ChromeSvg>;
}

/** The Data & services tab: a store of data, as the rail's Data reads. */
export function DataServicesIcon() {
  return <ChromeSvg strokeWidth={1.7}><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" /></ChromeSvg>;
}

/** The Security tab: a shield. */
export function ShieldIcon() {
  return <ChromeSvg strokeWidth={1.7}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /></ChromeSvg>;
}

export function ServerIcon() {
  return <ChromeSvg strokeWidth={1.7}><rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><path d="M6 6h.01M6 18h.01" /></ChromeSvg>;
}

/** The Maps tab: the rail's Maps glyph, at the chrome tier. */
export function MapsIcon() {
  return <ChromeSvg strokeWidth={1.7}><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6ZM9 3v15M15 6v15" /></ChromeSvg>;
}

/** The Workflows & SQL tab: the rail's Workflows glyph, at the chrome tier. */
export function WorkflowsIcon() {
  return <ChromeSvg strokeWidth={1.7}><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5" /><rect x="14" y="14" width="6.5" height="6.5" rx="1.5" /><path d="M10 6.75h4.75a2 2 0 0 1 2 2V14M14 17.25H9.25a2 2 0 0 1-2-2V10" /></ChromeSvg>;
}

/** The Publishing tab: a globe. */
export function PublishingIcon() {
  return <ChromeSvg strokeWidth={1.7}><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" /></ChromeSvg>;
}

/** The rail's Users glyph, at the chrome tier. */
export function UsersIcon() {
  return <ChromeSvg strokeWidth={1.7}><circle cx="9" cy="8" r="3" /><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 4v2" /></ChromeSvg>;
}

/** A link that leaves the page it sits on. */
export function ArrowRightIcon() {
  return <Svg><path d="M5 12h14M13 6l6 6-6 6" /></Svg>;
}

/** A template's mark: the rail's Templates compass, at the action tier. */
export function TemplateIcon() {
  return <Svg><circle cx="12" cy="12" r="9" /><path d="m15.6 8.4-2.1 5.1-5.1 2.1 2.1-5.1 5.1-2.1Z" /></Svg>;
}
