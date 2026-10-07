import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The mono boundary: mono is a contextual signal for code and data —
 * SQL, dataset values, identifiers, expression inputs, feature
 * readouts, machine errors — never chrome. This ratchet holds the
 * boundary at exact site identities: every way a mono face can land
 * (token uses, hardcoded stacks, shorthand and inline styles) is
 * collected from the app source and compared against the surviving
 * inventory below, both ways. A new or moved landing fails as growth; a
 * vanished landing fails as a stale allowance until its row is removed.
 * Shrinking the inventory with the source is the welcome direction;
 * growing it takes a spec.
 */

const ROOT = "src";
const MONO_PATTERN =
  /--font-mono|--font-dm-mono|--font-plex-mono|var\(--mono\b|"SF Mono"|DM.?Mono|Plex.?Mono|ui-monospace|Cascadia|\bmonospace\b/;

/** File :: selector (css) or file :: trimmed line (ts/tsx) for every
 * mono landing in one file's source. */
export function monoSites(file: string, source: string): string[] {
  const found: string[] = [];
  if (file.endsWith(".css")) {
    const noComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
    const re = /([^{}]+)\{([^{}]*)\}/g;
    for (let m = re.exec(noComments); m; m = re.exec(noComments)) {
      if (MONO_PATTERN.test(m[2])) {
        found.push(`${file} :: ${m[1].trim().replace(/\s+/g, " ")}`);
      }
    }
  } else {
    for (const line of source.split("\n")) {
      if (MONO_PATTERN.test(line.replace(/\/\/.*$/, ""))) {
        found.push(`${file} :: ${line.trim()}`);
      }
    }
  }
  return found;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(css|tsx|ts)$/.test(full) && !/\.test\./.test(full)) {
      yield full;
    }
  }
}

/** The surviving inventory — the keep set, exactly. */
const ALLOWED = new Set([
  "src/app/globals.css :: :root",
  "src/app/globals.css :: [data-published-view]",
  'src/app/layout.tsx :: import { Archivo, DM_Mono, Gabarito, IBM_Plex_Mono, Inter } from "next/font/google";',
  "src/app/layout.tsx :: const dmMono = DM_Mono({",
  'src/app/layout.tsx :: variable: "--font-dm-mono",',
  "src/app/layout.tsx :: const plexMono = IBM_Plex_Mono({",
  'src/app/layout.tsx :: variable: "--font-plex-mono",',
  "src/components/AddToMapDialog.module.css :: .nameField input",
  "src/components/connections/ConnectionForm.module.css :: .mono",
  "src/components/connections/ConnectionDetail.module.css :: .snapshotMain code, .snapshotMain small span, .identifier",
  "src/components/DocsScreen.module.css :: .errorTable code",
  "src/components/DocsScreen.module.css :: .method",
  "src/components/DocsScreen.module.css :: .path",
  "src/components/DocsScreen.module.css :: .sectionDesc code",
  "src/components/GeometryBadge.module.css :: .badge",
  // The record's source column is an identifier.
  "src/components/GeometryProvenance.module.css :: .record b",
  // The sign-in hand-over is a literal URL, including its credential.
  "src/components/users/UsersScreen.module.css :: .field input",
  // Typed confirmation repeats an exact account identifier, in the field and its label.
  "src/components/users/DeleteAccountDialog.module.css :: .field b, .field input",
  // A SQL name is an identifier other people's SQL qualifies datasets by:
  // on Users, beside a person in the share dialog, beside a person's group
  // in the console's source list, and in the catalogue's line naming a
  // dataset as a map's SQL types it.
  "src/components/users/UsersScreen.module.css :: .sqlName",
  "src/components/sharing/ShareDialog.module.css :: .sqlName",
  "src/components/sql/SqlConsole.module.css :: .eyebrowSql",
  "src/components/builder/add-layer/AddLayerCatalog.module.css :: .homeLine code",
  // Settings: the SQL name on the Account card is the same identifier.
  "src/components/settings/SettingsCard.module.css :: .sqlName code",
  // Settings: the variable that decides a setting the server holds is an
  // identifier, and a read-only value can be a path or an identifier.
  "src/components/settings/SettingRows.module.css :: .value[data-mono]",
  "src/components/settings/SettingRows.module.css :: .lockedNote code",
  "src/components/McpSection.module.css :: .endpoint",
  // per-client commands and configuration are literal code.
  "src/components/McpSection.module.css :: .configuration",
  "src/components/MiniMap.module.css :: .measure",
  "src/components/OsmPane.module.css :: .chip",
  "src/components/OsmPane.module.css :: .chips input",
  "src/components/OsmPane.module.css :: .hint code",
  "src/components/OsmPane.module.css :: .mono",
  "src/components/OverturePane.module.css :: .mono",
  "src/components/connections/PostgisPane.module.css :: .server",
  "src/components/connections/PostgisPane.module.css :: .relationName, .relationRows, .field input",
  // the import box's qualified source name is mono-bold.
  "src/components/connections/PostgisPane.module.css :: .importTitle code",
  // The title row's columns count is a fact beside
  // the mono facts it sits with, in the reference's own face.
  "src/components/connections/PostgisPane.module.css :: .qualified, .columnsToggle, .spatialFact, .columnList, .previewTable",
  "src/components/connections/PostgisPane.module.css :: .doneCard h3 code, .doneRelation",
  "src/components/ResultGrid.module.css :: .grid",
  "src/components/ResultGrid.module.css :: .resultMeta",
  // The save-as-dataset flow's name field and stored identifier.
  "src/components/SaveResultAsDataset.module.css :: .field input",
  "src/components/SaveResultAsDataset.module.css :: .storedAs code",
  "src/components/SqlEditor.tsx :: fontFamily: \"var(--font-mono)\",",
  // The completion list: code, in the editor's own face.
  "src/components/SqlEditor.tsx :: font: \"12px var(--font-mono)\",",
  // The Data preview grid, extracted from the detail screen by 0199.
  "src/components/TablePreviewGrid.module.css :: .grid",
  // The panel's header names the dataset, an identifier; the
  // column selects and the Other EPSG code field hold identifiers and a code.
  "src/components/set-geometry/SetGeometryPanel.module.css :: .head small",
  "src/components/set-geometry/SetGeometryPanel.module.css :: .mono",
  // The strip names the two columns it proposes.
  "src/components/set-geometry/ProposalStrip.module.css :: .strip code",
  "src/components/TableDetailScreen.module.css :: .title h1",
  "src/components/TablePreviewMap.module.css :: .readout",
  "src/components/TablesScreen.module.css :: .nameCell",
  // (reference pages 27, 28 and 23): the project home's list mode, its
  // recent rows and the picker carry a dataset's name in the code face,
  // exactly as the Data Explorer's rows (home row moved with them).
  "src/components/projects/HomeSections.module.css :: .monoName",
  "src/components/projects/EmptyHome.module.css :: .text b.mono",
  "src/components/projects/AddItemsDialog.module.css :: .text b.mono",
  // (reference page 14): the filing checklist's dataset names, the same
  // code-face rule.
  "src/components/projects/AddToProjectDialog.module.css :: .dsName",
  // (reference page 16, variant C): the export picker's dataset names,
  // the review's file tree and its file-name field are identifiers and
  // paths — the reference draws all of them mono.
  "src/components/projects/ExportProjectDialog.module.css :: .nameMono",
  "src/components/projects/ExportProjectDialog.module.css :: .tree",
  "src/components/projects/ExportProjectDialog.module.css :: .fileIn input",
  "src/components/projects/ExportProjectDialog.module.css :: .ext",
  "src/components/UrlImportPane.module.css :: .mono",
  // The workflow canvas: a source's table name, a node's output name and
  // a port's table are identifiers, as the account's were. (The zoom
  // readout's row left with the readout, removed on a field-round
  // ruling.)
  "src/components/workflow-canvas/WorkflowCanvas.module.css :: .pLabel",
  "src/components/workflow-canvas/WorkflowCanvas.module.css :: .rowName",
  "src/components/workflow-canvas/WorkflowCanvas.module.css :: .srcName",
  "src/components/workflow-canvas/WorkflowCanvas.module.css :: .tOut",
  // the node and source panels' data — a dataset name, a changed value old
  // and new, a column's type, an output's facts, the API's message in a
  // callout — set in the code face as reference 13 sets them.
  "src/components/workflow-canvas/WorkflowCanvas.module.css :: .callout .mono",
  "src/components/workflow-canvas/WorkflowCanvas.module.css :: .changeRow .was",
  "src/components/workflow-canvas/WorkflowCanvas.module.css :: .changeRow .now",
  "src/components/workflow-canvas/WorkflowCanvas.module.css :: .kv dd",
  "src/components/workflow-canvas/WorkflowCanvas.module.css :: .colType",
  "src/components/workflow-canvas/WorkflowCanvas.module.css :: .nameInput",
  // the wide-run confirmation names the dataset each node writes.
  "src/components/workflow-canvas/WorkflowCanvas.module.css :: .planList code",
  // the Messages log's clock column.
  "src/components/workflow-canvas/ResultsBand.module.css :: .ts",
  // the band's lead names a dataset, the map's readout, the provenance's
  // input names, the SQL that ran and a disclosure's values — identifiers,
  // code and data, as reference 13 sets them.
  "src/components/workflow-canvas/ResultsBand.module.css :: .lead b",
  "src/components/workflow-canvas/ResultsBand.module.css :: .readout",
  "src/components/workflow-canvas/ResultsBand.module.css :: .provFacts code",
  "src/components/workflow-canvas/ResultsBand.module.css :: .sqlText",
  "src/components/workflow-canvas/ResultsBand.module.css :: .disclosure dd",
  // a note's label strip, its rendered inline code and its raw text in the
  // field — a tag, code and markdown source, as reference 13 sets them.
  "src/components/workflow-canvas/NoteNode.module.css :: .label",
  "src/components/workflow-canvas/NoteNode.module.css :: .body code",
  "src/components/workflow-canvas/NoteNode.module.css :: .edit",
  // The input picker's chosen name and its rows' names.
  "src/components/workflow-canvas/InputPicker.module.css :: .name",
  // The editor's placeholder mirrors the editor's metrics.
  "src/components/workflow-canvas/NoteNode.module.css :: .placeholder",
  "src/components/builder/AssistantPanel.module.css :: .sql",
  // (the assistant on three pages) grows the set by three: a reply's
  // code block and a SQL proposal are code, the exact text the model
  // wrote (item 6, D2); the "talking about" chip's layer name is an
  // identifier the named reference draws in the mono face (item 1, page
  // 02 section 1 A).
  "src/components/builder/AssistantPanel.module.css :: .code",
  // Item 1: inline code in a reply's rendered markdown is code.
  "src/components/builder/AssistantPanel.module.css :: .reply code",
  "src/components/builder/AssistantPanel.module.css :: .proposalSql",
  "src/components/builder/assistant/TalkingAbout.module.css :: .mono",
  // Item 5: the picker's menu shows each model's raw identity beside
  // its display name, an identifier rule, and page 04 option A draws it
  // in the mono face (`.mItem.mId`).
  "src/components/builder/assistant/ModelPicker.module.css :: .identity",
  "src/components/builder/AssistantPanel.module.css :: .tool",
  // the record's inspection (page 02 section 2 A) shows an action's
  // operation identifier and its retained inputs (argument names and
  // values, `attribute: area_ha`), code and data rule.
  "src/components/builder/AssistantPanel.module.css :: .inspectionInput dt",
  "src/components/builder/AssistantPanel.module.css :: .inspectionInput dd",
  "src/components/builder/AssistantPanel.module.css :: .toolId",
  "src/components/builder/FilterSection.module.css :: .badge",
  "src/components/builder/FilterSection.module.css :: .bound",
  "src/components/builder/FilterSection.module.css :: .fieldName",
  "src/components/builder/LegendTab.module.css :: .attrInput",
  "src/components/builder/PaletteControl.module.css :: .stopPos",
  "src/components/builder/StylePanel.module.css :: .breakInput",
  "src/components/builder/StylePanel.module.css :: .num",
  "src/components/builder/add-layer/AddLayerCatalog.module.css :: .tableName",
  "src/components/builder/draw/draw.module.css :: .draftLabel",
  "src/components/builder/drawer/ParameterForm.module.css :: .number",
  "src/components/builder/drawer/ParameterForm.module.css :: .textarea",
  "src/components/builder/drawer/SuccessFace.module.css :: .table code",
  "src/components/builder/export/ExportComposition.module.css :: .frame",
  "src/components/builder/publish/PublishPopover.module.css :: .fieldName",
  "src/components/builder/publish/PublishPopover.module.css :: .snippet",
  "src/components/builder/publish/PublishPopover.module.css :: .url",
  "src/components/gallery.module.css :: .geomCell",
  "src/components/gallery.module.css :: .numCell",
  "src/components/map/MapCanvas.module.css :: .popup",
  "src/components/map/MapCanvas.module.css :: .tooltip",
  // The SQL console: table and column identifiers, the previewed
  // table's name, the result grid's cells and peek, the map's feature
  // readout and hover, the engine's error code — code and data, never
  // chrome.
  "src/components/sql/SqlConsole.module.css :: .errorCode",
  "src/components/sql/SqlConsole.module.css :: .grid",
  "src/components/sql/SqlConsole.module.css :: .lead b",
  "src/components/sql/SqlConsole.module.css :: .mapReadout",
  "src/components/sql/SqlConsole.module.css :: .mapTip",
  "src/components/sql/SqlConsole.module.css :: .peekValue",
  "src/components/sql/SqlConsole.module.css :: .resNotes code",
  "src/components/sql/SqlConsole.module.css :: .rowName",
  "src/components/ui/ErrorNote.module.css :: .detailText",
]);

describe("the mono boundary", () => {
  const found = new Map<string, string[]>();
  let filesScanned = 0;
  for (const file of walk(ROOT)) {
    filesScanned += 1;
    for (const site of monoSites(file, readFileSync(file, "utf8"))) {
      found.set(site, [...(found.get(site) ?? []), site]);
    }
  }

  it("actually scans the tree (the check is not vacuous)", () => {
    expect(filesScanned).toBeGreaterThan(200);
    // Representative survivors from distinct rule classes must be seen,
    // or the collector went blind rather than the tree going clean.
    expect(found.has('src/components/SqlEditor.tsx :: fontFamily: "var(--font-mono)",')).toBe(true);
    expect(found.has("src/components/ResultGrid.module.css :: .grid")).toBe(true);
    expect(ALLOWED.size).toBeGreaterThan(30);
  });

  it("no mono lands outside the inventory (growth fails)", () => {
    const growth = [...found.keys()].filter((site) => !ALLOWED.has(site));
    expect(
      growth,
      "mono landed outside the code/data inventory — demote it, or a spec grows the set",
    ).toEqual([]);
  });

  it("no inventory row outlives its site (stale allowances fail)", () => {
    const stale = [...ALLOWED].filter((site) => !found.has(site));
    expect(
      stale,
      "an inventoried mono site no longer exists — shrink the inventory",
    ).toEqual([]);
  });

  it("a landing is not counted twice under one identity", () => {
    // Two identical declarations under one selector identity would let
    // a duplicate hide; identities must be unique in the tree.
    const dupes = [...found.entries()].filter(([, v]) => v.length > 1);
    expect(dupes.map(([k]) => k)).toEqual([]);
  });

  it("rejects a chrome landing fed through the real collector", () => {
    // The collector itself, not a matcher echo: synthetic chrome rules
    // must surface as growth against the inventory — via the app token,
    // via a loaded face used directly, and via a hardcoded stack (the
    // PR round's finding: the direct-use road was unmatched).
    for (const decl of [
      "font-family: var(--font-mono);",
      "font-family: var(--font-dm-mono);",
      'font-family: "IBM Plex Mono", monospace;',
    ]) {
      const seeded = monoSites(
        "src/components/Fake.module.css",
        `.label { ${decl} }`,
      );
      expect(seeded, decl).toEqual([
        "src/components/Fake.module.css :: .label",
      ]);
      expect(ALLOWED.has(seeded[0])).toBe(false);
    }
  });
});
