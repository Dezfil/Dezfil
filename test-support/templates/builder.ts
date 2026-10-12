import { createHash } from "node:crypto";
import { cp, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { withConnection } from "../../src/lib/duckdb";
import { encodePng } from "../../src/lib/export/png-codec";
import { PROJECT_EXPORT_FORMAT_VERSION } from "../../src/lib/export/project-export";
import { defaultStyle } from "../../src/lib/style/defaults";
import {
  FACTS_FILE,
  MANIFEST_FILE,
  TEMPLATE_FORMAT_VERSION,
  type TemplateFacts,
  type TemplateKind,
} from "../../src/lib/templates/format";
import {
  RECORD_FILE,
  RECORD_FORMAT_VERSION,
  type DatasetMeasurement,
  type InstalledOrigin,
  type InstalledRecord,
} from "../../src/lib/templates/installed";
import { buildZip, type ZipMember } from "../zip";

/**
 * The template fixture: a small, real template built the way the format
 * says, with a knob for every way one must be refused.
 *
 * A map template is a map with two layers on two datasets (stations as
 * points, districts as polygons), a formula widget, a note widget naming
 * both sources with their licences, and a manual legend order. A workflow
 * example adds a workflow of two steps (a SQL step over the stations, a
 * buffer of its output), with a layout and a note, each step's bundled
 * result, and a map drawing those results. The datasets and results are
 * GeoParquet the engine writes; the pictures are PNG.
 *
 * Built twice over: as the version folder (the installed form, unpacked)
 * and as the archive a catalogue serves (one `<id>.dezfil/` root, as the
 * project export writes it). A test changes what it needs through `edit`,
 * which sees every document as an object and every other member as bytes
 * before either form is written, or through the named seeds below.
 */

export const FIXTURE_SOURCES = [
  {
    name: "Example Transit Office",
    licence: "CC-BY-4.0",
    credit: "Contains example transit data from the Example Transit Office.",
  },
  {
    name: "Example Boundary Office",
    licence: "OGL-UK-3.0",
    credit: "Contains example boundary data from the Example Boundary Office.",
  },
] as const;

/** The note widget's text: every source with its licence and credit. */
export const FIXTURE_CREDIT_NOTE = FIXTURE_SOURCES
  .map((s) => `${s.name} (${s.licence}). ${s.credit}`)
  .join("\n\n");

/** One version's members before they are written: documents as objects,
 * everything else as bytes, keyed by their path in the version folder. */
export interface TemplateFiles {
  documents: Map<string, Record<string, unknown>>;
  binaries: Map<string, Buffer>;
}

export interface TemplateFixtureOptions {
  kind?: TemplateKind;
  id?: string;
  version?: number;
  title?: string;
  /** Change any member before the forms are written. */
  edit?: (files: TemplateFiles) => void;
  /** Change the archive's members (hostile names, lying sizes, flags). */
  zip?: (members: ZipMember[]) => ZipMember[];
  /** Place the archive after a hole of this many bytes: an archive past
   * a size bound whose bytes are never written. */
  sparseBytes?: number;
}

export interface BuiltTemplate {
  facts: TemplateFacts;
  /** The version folder, the installed form. */
  folder: string;
  /** The archive, the transport form. */
  archive: string;
  /** The archive's root folder name. */
  root: string;
  size: number;
  sha256: string;
  files: TemplateFiles;
}

const STATIONS = [
  ["s1", "Harbour", 340, "2019-03-01", -0.1276, 51.5072],
  ["s2", "Market", 220, "2019-06-12", -0.1195, 51.5101],
  ["s3", "Bridge", 180, "2020-01-20", -0.1340, 51.5034],
  ["s4", "Hill", 90, "2020-05-05", -0.1412, 51.5129],
  ["s5", "Park", 60, "2021-02-14", -0.1101, 51.4988],
  ["s6", "Docks", 410, "2021-09-30", -0.1003, 51.5055],
] as const;

const DISTRICTS = [
  ["d1", "West", 12000, "POLYGON((-0.15 51.49, -0.12 51.49, -0.12 51.52, -0.15 51.52, -0.15 51.49))"],
  ["d2", "East", 9500, "POLYGON((-0.12 51.49, -0.09 51.49, -0.09 51.52, -0.12 51.52, -0.12 51.49))"],
] as const;

const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** The engine writes each table once per process; the bytes are fixed. */
let tables: Promise<Map<string, Buffer>> | null = null;

function engineTables(): Promise<Map<string, Buffer>> {
  tables ??= (async () => {
    const dir = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(path.join(process.cwd(), ".tmp-test-template-tables-")),
    );
    try {
      const stations = STATIONS.map(([id, name, riders, opened, lng, lat]) =>
        `(${sqlString(id)}, ${sqlString(name)}, ${riders}, DATE ${sqlString(opened)}, ST_Point(${lng}, ${lat}))`).join(", ");
      const districts = DISTRICTS.map(([id, name, population, wkt]) =>
        `(${sqlString(id)}, ${sqlString(name)}, ${population}, ST_GeomFromText(${sqlString(wkt)}))`).join(", ");
      const files: Record<string, string> = {
        stations: `SELECT * FROM (VALUES ${stations}) t(id, name, riders, opened, geom)`,
        districts: `SELECT * FROM (VALUES ${districts}) t(id, name, population, geom)`,
        busy_stations: `SELECT * FROM (VALUES ${stations}) t(id, name, riders, opened, geom) WHERE riders > 100`,
        station_rings: `SELECT id, name, riders, ST_Buffer(geom, 0.0025) AS geom FROM (VALUES ${stations}) t(id, name, riders, opened, geom) WHERE riders > 100`,
      };
      const out = new Map<string, Buffer>();
      await withConnection(async (conn) => {
        for (const [name, select] of Object.entries(files)) {
          const target = path.join(dir, `${name}.parquet`);
          await conn.run(`COPY (${select}) TO ${sqlString(target)} (FORMAT PARQUET)`);
          out.set(name, await readFile(target));
        }
      });
      return out;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return tables;
}

function picture(rgb: [number, number, number]): Buffer {
  const width = 16;
  const height = 10;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([...rgb, 255], i * 4);
  return Buffer.from(encodePng({ width, height, rgba }));
}

function layer(id: string, name: string, sql: string, geometry: string, index: number) {
  return {
    id, mapId: "map-1", name, sql,
    style: defaultStyle(geometry, index),
    visible: true, tooltip: null, popup: null, publishedFields: null, inLegend: true,
    viz: { type: "points" }, filters: [],
    legendTitle: null, legendLabels: null, legendAttrs: null,
    ordinal: index, createdAt: "2026-01-05T10:00:00.000Z", updatedAt: "2026-01-05T10:00:00.000Z",
    editRevision: "r1", lastChangedAt: null, lastChangedBy: null,
  };
}

/** The members of a fresh fixture version, before any knob. */
export async function fixtureFiles(options: TemplateFixtureOptions = {}): Promise<TemplateFiles> {
  const kind = options.kind ?? "map";
  const id = options.id ?? (kind === "map" ? "harbour-stations" : "busy-stations");
  const version = options.version ?? 1;
  const engine = await engineTables();
  const documents = new Map<string, Record<string, unknown>>();
  const binaries = new Map<string, Buffer>();
  const datasets = ["stations", "districts"];

  const layers = kind === "map"
    ? [
        layer("layer-stations", "Stations", "SELECT * FROM stations", "POINT", 0),
        layer("layer-districts", "Districts", "SELECT * FROM districts", "POLYGON", 1),
      ]
    : [
        layer("layer-rings", "Rings", "SELECT * FROM station_rings", "POLYGON", 0),
        layer("layer-busy", "Busy stations", "SELECT * FROM busy_stations", "POINT", 1),
      ];
  const first = layers[0].id;
  const second = layers[1].id;

  const facts: TemplateFacts = {
    formatVersion: TEMPLATE_FORMAT_VERSION,
    id,
    version,
    kind,
    title: options.title ?? (kind === "map" ? "Harbour stations" : "Busy stations"),
    question: kind === "map" ? "Where are the stations?" : "Which stations are busy, and what is near them?",
    place: "Example City",
    tags: kind === "map" ? ["First map"] : ["Analysis", "Widgets"],
    dataDate: "2024-05",
    sources: FIXTURE_SOURCES.map((s) => ({ ...s })),
    howMade: {
      question: "Stations from the transit office, districts from the boundary office.",
      datasets: [
        { dataset: "stations", source: FIXTURE_SOURCES[0].name, made: "Station points as published." },
        { dataset: "districts", source: FIXTURE_SOURCES[1].name, made: "District outlines, simplified." },
      ],
      styling: ["Stations as points in the first layer colour.", "Districts as translucent areas."],
    },
    // A workflow example's steps as its card draws its graph: what each
    // runs, makes and reads, the workflow document's own.
    ...(kind === "workflow"
      ? {
          steps: [
            { id: "step-busy", operation: "sql_step", output: "busy_stations", reads: ["stations"] },
            { id: "step-rings", operation: "buffer", output: "station_rings", reads: ["busy_stations"] },
          ],
        }
      : {}),
    pictures: { light: "pictures/light.png", dark: "pictures/dark.png" },
  };
  documents.set(FACTS_FILE, facts as unknown as Record<string, unknown>);

  const manifest = {
    formatVersion: PROJECT_EXPORT_FORMAT_VERSION,
    generator: "dezfil",
    exportedAt: "2026-01-05T10:00:00.000Z",
    exportedBy: { sqlName: "author" },
    project: { name: facts.title, note: null },
    contents: {
      maps: [{ id: "map-1", name: facts.title, file: "maps/map.json" }],
      workflows: kind === "workflow"
        ? [{ id: "workflow-1", name: facts.title, file: "workflows/workflow.json" }]
        : [],
      datasets: datasets.map((name) => ({
        id: `dataset-${name}`, name, qualifiedName: name,
        owner: { name: "Author", sqlName: "author" },
        file: `datasets/${name}.parquet`, format: "geoparquet",
      })),
    },
  };
  documents.set(MANIFEST_FILE, manifest);

  documents.set("maps/map.json", {
    id: "map-1",
    name: facts.title,
    viewport: { lng: -0.12, lat: 51.505, zoom: 12, pitch: 0, bearing: 0 },
    basemap: null,
    customBasemap: null,
    basemapLayers: null,
    note: null,
    legendCorner: null,
    legendOrder: [second, first],
    timeline: null,
    widgets: [
      {
        id: "widget-riders", type: "formula", layerId: kind === "map" ? first : second,
        title: "Riders", field: "riders", agg: "sum", aggField: null, unit: null,
        note: null, format: null, visible: true,
      },
      {
        id: "widget-credit", type: "note", layerId: null, title: "Sources",
        field: null, agg: "count", aggField: null, unit: null,
        note: FIXTURE_CREDIT_NOTE, format: null, visible: true,
      },
    ],
    widgetsPublished: true,
    createdAt: "2026-01-05T10:00:00.000Z",
    updatedAt: "2026-01-05T10:00:00.000Z",
    layers,
    owner: { name: "Author", sqlName: "author" },
    home: "author",
    editRevision: "r1",
    lastChangedAt: null,
    lastChangedBy: null,
  });

  if (kind === "workflow") {
    documents.set("workflows/workflow.json", {
      id: "workflow-1",
      name: facts.title,
      origin: "workflow",
      home: "author",
      createdAt: "2026-01-05T10:00:00.000Z",
      updatedAt: "2026-01-05T10:00:00.000Z",
      steps: [
        {
          id: "step-busy", ordinal: 0, operation: "sql_step",
          parameters: { sql: "SELECT * FROM stations WHERE riders > 100", name: "busy_stations" },
          origin: null,
        },
        {
          id: "step-rings", ordinal: 1, operation: "buffer",
          parameters: { input: "busy_stations", distance: 250, name: "station_rings" },
          origin: null,
        },
      ],
      layout: {
        editRevision: "r1", lastChangedAt: null, lastChangedBy: null, updatedAt: null,
        steps: { "step-busy": { x: 320, y: 40 }, "step-rings": { x: 620, y: 40 } },
        sources: { stations: { x: 20, y: 40 } },
        notes: [{ id: "note-1", x: 320, y: 220, w: 240, h: 120, color: "yellow", text: "Busy means more than a hundred riders." }],
      },
    });
    binaries.set("results/step-busy.parquet", engine.get("busy_stations")!);
    binaries.set("results/step-rings.parquet", engine.get("station_rings")!);
  }

  for (const name of datasets) binaries.set(`datasets/${name}.parquet`, engine.get(name)!);
  binaries.set("pictures/light.png", picture([236, 240, 232]));
  binaries.set("pictures/dark.png", picture([24, 30, 28]));
  return { documents, binaries };
}

function memberBytes(files: TemplateFiles): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const [name, doc] of files.documents) out.set(name, Buffer.from(JSON.stringify(doc, null, 2) + "\n"));
  for (const [name, bytes] of files.binaries) out.set(name, bytes);
  return out;
}

/** Write a version's members as a version folder. */
export async function writeVersionFolder(folder: string, files: TemplateFiles): Promise<void> {
  for (const [name, bytes] of memberBytes(files)) {
    const target = path.join(folder, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

/** Write a version's members as an archive with one root folder. */
export async function writeArchive(
  file: string,
  root: string,
  files: TemplateFiles,
  options: Pick<TemplateFixtureOptions, "zip" | "sparseBytes"> = {},
): Promise<void> {
  let members: ZipMember[] = [...memberBytes(files)].map(([name, data]) => ({ name: `${root}/${name}`, data }));
  if (options.zip) members = options.zip(members);
  await mkdir(path.dirname(file), { recursive: true });
  const baseOffset = options.sparseBytes ?? 0;
  const zip = buildZip(members, { baseOffset });
  const handle = await open(file, "w");
  try {
    // Written past a hole: the file has the size without the bytes.
    await handle.write(zip, 0, zip.length, baseOffset);
  } finally {
    await handle.close();
  }
}

/**
 * Build a fixture template under `dir`: the version folder at
 * `<dir>/version` and the archive at `<dir>/<id>-<version>.zip`.
 */
export async function buildTemplate(dir: string, options: TemplateFixtureOptions = {}): Promise<BuiltTemplate> {
  const files = await fixtureFiles(options);
  options.edit?.(files);
  const facts = files.documents.get(FACTS_FILE) as unknown as TemplateFacts;
  const id = typeof facts?.id === "string" ? facts.id : "template";
  const version = typeof facts?.version === "number" ? facts.version : 1;
  const folder = path.join(dir, "version");
  const archive = path.join(dir, `${id}-${version}.zip`);
  const root = `${id}.dezfil`;
  await writeVersionFolder(folder, files);
  await writeArchive(archive, root, files, options);
  const bytes = options.sparseBytes ? null : await readFile(archive);
  return {
    facts,
    folder,
    archive,
    root,
    size: bytes ? bytes.length : (await import("node:fs/promises").then((fs) => fs.stat(archive))).size,
    sha256: bytes ? createHash("sha256").update(bytes).digest("hex") : "",
    files,
  };
}

const map = (files: TemplateFiles) => files.documents.get("maps/map.json")!;
const workflow = (files: TemplateFiles) => files.documents.get("workflows/workflow.json")!;
const facts = (files: TemplateFiles) => files.documents.get(FACTS_FILE)!;
const manifest = (files: TemplateFiles) => files.documents.get(MANIFEST_FILE)!;
const factSteps = (files: TemplateFiles) =>
  facts(files).steps as { id: string; operation: string; output: string; reads: string[] }[];

/** An edit putting the first source under another licence, its credit
 * note naming that licence in place of the fixture's. */
export function underLicence(licence: string) {
  return (files: TemplateFiles) => {
    const sources = facts(files).sources as { licence: string }[];
    sources[0].licence = licence;
    const note = (map(files).widgets as Record<string, unknown>[]).find((w) => w.type === "note")!;
    note.note = (note.note as string).replace(FIXTURE_SOURCES[0].licence, licence);
  };
}

/**
 * Named seeds, each one fault of the admission's, for a test to build a
 * fixture that must be refused. Workflow seeds need a workflow example.
 */
export const SEEDS = {
  /** A source under a non-commercial licence, credited as such. */
  nonCommercialLicence: underLicence("CC-BY-NC-4.0"),
  /** A credit note naming one source of two. */
  missingCredit: (files: TemplateFiles) => {
    const note = (map(files).widgets as Record<string, unknown>[]).find((w) => w.type === "note")!;
    note.note = `${FIXTURE_SOURCES[0].name} (${FIXTURE_SOURCES[0].licence}). ${FIXTURE_SOURCES[0].credit}`;
  },
  /** A publication's token on the map. */
  publicationToken: (files: TemplateFiles) => { map(files).publishToken = "seeded-publication-0001"; },
  /** A live publication on the map. */
  publishedMap: (files: TemplateFiles) => { map(files).published = true; },
  /** A pasted basemap style: an address the server would reach. */
  customBasemap: (files: TemplateFiles) => {
    map(files).customBasemap = { url: "https://styles.example/seeded-style.json", name: null, attribution: [] };
  },
  /** A connection named in a dataset entry. */
  connection: (files: TemplateFiles) => {
    ((manifest(files).contents as Record<string, unknown[]>).datasets[0] as Record<string, unknown>).connectionId = "seeded-connection-0001";
  },
  /** A setting carried in the facts. */
  setting: (files: TemplateFiles) => { facts(files).settings = { uploadMaxMb: 1 }; },
  /** A format version this server does not read. */
  staleFormatVersion: (files: TemplateFiles) => { facts(files).formatVersion = 0; },
  /** An export format version this server does not read. */
  laterExportVersion: (files: TemplateFiles) => { manifest(files).formatVersion = PROJECT_EXPORT_FORMAT_VERSION + 1; },
  /** The facts missing a field. */
  factsWithoutPlace: (files: TemplateFiles) => { delete facts(files).place; },
  /** A tag outside the closed list. */
  unknownTag: (files: TemplateFiles) => { facts(files).tags = ["Weather"]; },
  /** A widget pointing at a layer the map does not have. */
  strayWidget: (files: TemplateFiles) => {
    (map(files).widgets as Record<string, unknown>[])[0].layerId = "layer-elsewhere";
  },
  /** A layer whose style is not a style. */
  invalidStyle: (files: TemplateFiles) => {
    (map(files).layers as Record<string, unknown>[])[0].style = { fill: "red" };
  },
  /** A legend order naming a layer twice. */
  invalidLegendOrder: (files: TemplateFiles) => {
    const ids = (map(files).layers as { id: string }[]).map((l) => l.id);
    map(files).legendOrder = [ids[0], ids[0]];
  },
  /** A camera past its bounds. */
  invalidViewport: (files: TemplateFiles) => { map(files).viewport = { lng: 0, lat: 120, zoom: 3 }; },
  /** A missing picture. */
  missingPicture: (files: TemplateFiles) => { files.binaries.delete("pictures/dark.png"); },
  /** A picture that is not a PNG. */
  pictureNotPng: (files: TemplateFiles) => { files.binaries.set("pictures/dark.png", Buffer.from("seeded picture text")); },
  /** A picture past its bound. */
  oversizedPicture: (files: TemplateFiles) => {
    const png = files.binaries.get("pictures/light.png")!;
    // A PNG header followed by bytes a reader never needs: still a PNG by
    // its signature, past the bound by its size.
    files.binaries.set("pictures/light.png", Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024 + 1)]));
  },
  /** A dataset the manifest names but the template does not hold. */
  missingDataset: (files: TemplateFiles) => { files.binaries.delete("datasets/districts.parquet"); },
  /** A member nothing names. */
  strayMember: (files: TemplateFiles) => { files.binaries.set("datasets/extra.parquet", Buffer.from("PAR1")); },
  /** A document that is not JSON (written as bytes in a document's place). */
  mapNotJson: (files: TemplateFiles) => {
    files.documents.delete("maps/map.json");
    files.binaries.set("maps/map.json", Buffer.from("{ not json"));
  },
  /** A step reaching an outside service. */
  geocodingStep: (files: TemplateFiles) => {
    const step = (workflow(files).steps as Record<string, unknown>[])[0];
    step.operation = "geocode_addresses";
  },
  /** A step whose operation the catalogue does not know. */
  unknownOperation: (files: TemplateFiles) => {
    (workflow(files).steps as Record<string, unknown>[])[0].operation = "seeded_operation";
  },
  /** A step without its bundled result. */
  missingResult: (files: TemplateFiles) => { files.binaries.delete("results/step-rings.parquet"); },
  /** Two steps declaring one output name. */
  duplicateOutput: (files: TemplateFiles) => {
    const steps = workflow(files).steps as { parameters: Record<string, unknown> }[];
    steps[1].parameters.name = steps[0].parameters.name;
  },
  /** A layer whose SQL names a dataset the template does not hold. */
  layerReferenceOutside: (files: TemplateFiles) => {
    (map(files).layers as Record<string, unknown>[])[0].sql = "SELECT * FROM roads";
  },
  /** The stations layer drawing each station fifty thousand times: 300,000
   * points, over the default render cap of 250,000. */
  layerOverRenderCap: (files: TemplateFiles) => {
    (map(files).layers as Record<string, unknown>[])[0].sql = "SELECT s.* FROM stations AS s, range(50000) AS copies(n)";
  },
  /** That layer again, with a range filter its canvas applies live: drawn
   * without it the result is over the cap, so the render applies every
   * filter on the server and draws the 100,000 points left. */
  layerUnderRenderCapFiltered: (files: TemplateFiles) => {
    const layer = (map(files).layers as Record<string, unknown>[])[0];
    layer.sql = "SELECT s.* FROM stations AS s, range(50000) AS copies(n)";
    layer.filters = [{ field: "riders", kind: "range", min: 0, max: 100 }];
  },
  /** A step whose SQL reads a dataset the template does not hold. */
  stepReferenceOutside: (files: TemplateFiles) => {
    (workflow(files).steps as { parameters: Record<string, unknown> }[])[0].parameters.sql = "SELECT * FROM roads WHERE riders > 100";
  },
  /** The stations layer reading its dataset through a table function's
   * listed argument, which a copy's rewrite of table names never reaches. */
  layerListedName: (files: TemplateFiles) => {
    (map(files).layers as Record<string, unknown>[])[0].sql = "SELECT * FROM query_table(['stations'])";
  },
  /** The stations layer naming its dataset in a table function's string. */
  layerStringName: (files: TemplateFiles) => {
    (map(files).layers as Record<string, unknown>[])[0].sql = "SELECT * FROM query_table('stations')";
  },
  /** The stations layer computing its dataset's name. */
  layerComputedName: (files: TemplateFiles) => {
    (map(files).layers as Record<string, unknown>[])[0].sql = "SELECT * FROM query_table('sta' || 'tions')";
  },
  /** The stations layer handing its dataset's name to a function that
   * reads a table by name. */
  layerFunctionOverName: (files: TemplateFiles) => {
    (map(files).layers as Record<string, unknown>[])[0].sql =
      "SELECT s.* FROM stations AS s WHERE (SELECT count(*) FROM pragma_table_info('stations')) > 0";
  },
  /** The stations layer handing its dataset's name to a file reader. */
  layerReaderOverName: (files: TemplateFiles) => {
    (map(files).layers as Record<string, unknown>[])[0].sql = "SELECT * FROM read_parquet('stations')";
  },
  /** The stations layer reading its dataset inside SQL carried as a string. */
  layerNestedQuery: (files: TemplateFiles) => {
    (map(files).layers as Record<string, unknown>[])[0].sql = "SELECT * FROM query('SELECT * FROM stations')";
  },
  /** The stations layer naming its dataset by a string in a table's place. */
  layerStringTable: (files: TemplateFiles) => {
    (map(files).layers as Record<string, unknown>[])[0].sql = "SELECT * FROM 'stations'";
  },
  /** The SQL step reading its dataset through a table function's listed
   * argument. */
  stepListedName: (files: TemplateFiles) => {
    (workflow(files).steps as { parameters: Record<string, unknown> }[])[0].parameters.sql =
      "SELECT * FROM query_table(['stations']) WHERE riders > 100";
  },
  /** The stations layer qualifying its dataset by a schema. */
  layerSchemaTable: (files: TemplateFiles) => {
    (map(files).layers as Record<string, unknown>[])[0].sql = "SELECT * FROM main.stations";
  },
  /** The stations layer qualifying a column by its dataset's schema and
   * name, the dataset named plainly. */
  layerSchemaColumn: (files: TemplateFiles) => {
    (map(files).layers as Record<string, unknown>[])[0].sql = "SELECT riders, main.stations.geom FROM stations";
  },
  /** The stations layer qualifying its dataset and a column by a schema. */
  layerSchemaColumnAndTable: (files: TemplateFiles) => {
    (map(files).layers as Record<string, unknown>[])[0].sql = "SELECT riders, main.stations.geom FROM main.stations";
  },
  /** The stations layer reading its dataset's whole row through a column
   * qualified by a schema, the dataset named plainly. */
  layerSchemaRow: (files: TemplateFiles) => {
    (map(files).layers as Record<string, unknown>[])[0].sql = "SELECT * FROM stations WHERE main.stations IS NOT NULL";
  },
  /** The SQL step qualifying its dataset by a catalogue and a schema. */
  stepSchemaTable: (files: TemplateFiles) => {
    (workflow(files).steps as { parameters: Record<string, unknown> }[])[0].parameters.sql =
      "SELECT * FROM temp.main.stations WHERE riders > 100";
  },
  /** A widget reading a column its layer's result does not have. */
  widgetColumnMissing: (files: TemplateFiles) => {
    (map(files).widgets as Record<string, unknown>[])[0].field = "seeded_column";
  },
  /** A dataset the upload's reader cannot read. */
  unreadableDataset: (files: TemplateFiles) => {
    files.binaries.set("datasets/districts.parquet", Buffer.from("PAR1 seeded bytes that are no table PAR1"));
  },
  /** A layout note of a colour the canvas does not draw. */
  invalidLayoutNote: (files: TemplateFiles) => {
    const layout = workflow(files).layout as { notes: Record<string, unknown>[] };
    layout.notes[0].color = "seeded-colour";
  },
  /** A workflow example's facts listing no steps. */
  factsWithoutSteps: (files: TemplateFiles) => { delete facts(files).steps; },
  /** A map template's facts listing a step. */
  mapFactsWithSteps: (files: TemplateFiles) => {
    facts(files).steps = [{ id: "step-busy", operation: "sql_step", output: "busy_stations", reads: ["stations"] }];
  },
  /** A step in the facts reading a name that is neither a dataset of the
   * template nor an earlier step's output. */
  stepFactsReadUnknown: (files: TemplateFiles) => { factSteps(files)[0].reads = ["roads"]; },
  /** The facts listing the first step under another id than the workflow's. */
  stepFactsId: (files: TemplateFiles) => { factSteps(files)[0].id = "step-first"; },
  /** The facts naming the second step's operation as another. */
  stepFactsOperation: (files: TemplateFiles) => { factSteps(files)[1].operation = "sql_step"; },
  /** The facts naming the first step's output, and what reads it, by
   * another name than the workflow declares. */
  stepFactsOutput: (files: TemplateFiles) => {
    const steps = factSteps(files);
    steps[0].output = "busiest_stations";
    steps[1].reads = ["busiest_stations"];
  },
  /** The facts listing the first of the workflow's two steps alone. */
  stepFactsMissingStep: (files: TemplateFiles) => { facts(files).steps = factSteps(files).slice(0, 1); },
  /** The facts saying the SQL step reads the districts, which it does not:
   * only its parse can tell. */
  stepFactsReadsSql: (files: TemplateFiles) => { factSteps(files)[0].reads = ["districts"]; },
  /** The facts saying the buffer reads the stations, where its input is
   * the first step's output. */
  stepFactsReadsDeclared: (files: TemplateFiles) => { factSteps(files)[1].reads = ["stations"]; },
} as const satisfies Record<string, (files: TemplateFiles) => void>;

/** Archive-level seeds: the shapes of the container a reader must refuse. */
export const ARCHIVE_SEEDS = {
  /** A member whose path climbs out of its folder. */
  escapingEntry: (members: ZipMember[]) => [...members, { name: "../escaped.json", data: "{}" }],
  /** A member listed under a second root. */
  secondRoot: (members: ZipMember[]) => [...members, { name: "other.dezfil/project.json", data: "{}" }],
  /** One member written twice. */
  duplicateMember: (members: ZipMember[]) => [...members, members[0]],
  /** Members whose declared sizes lie: together far past the upload cap. */
  lyingUnpackedSize: (members: ZipMember[]) => members.map((m) => ({ ...m, declaredUncompressedSize: 0xfffffff0 })),
  /** A member marked encrypted. */
  encryptedMember: (members: ZipMember[]) => members.map((m, i) => (i === 0 ? { ...m, flags: 1 } : m)),
} as const satisfies Record<string, (members: ZipMember[]) => ZipMember[]>;

/** What the dataset reader measures of the fixture's datasets and results:
 * the rows the engine wrote, by member. */
export const FIXTURE_MEASUREMENTS: Record<string, DatasetMeasurement> = {
  "datasets/stations.parquet": { rowCount: 6, geometryColumn: "geom", geometryType: "POINT", crsAssumed: false },
  "datasets/districts.parquet": { rowCount: 2, geometryColumn: "geom", geometryType: "POLYGON", crsAssumed: false },
  "results/step-busy.parquet": { rowCount: 4, geometryColumn: "geom", geometryType: "POINT", crsAssumed: false },
  "results/step-rings.parquet": { rowCount: 4, geometryColumn: "geom", geometryType: "POLYGON", crsAssumed: false },
};

async function membersOf(folder: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(folder, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await membersOf(folder, rel)));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * Install a built template as an installed version folder at `target`:
 * its members and a record written here, from what is on disk, without
 * the admission. A fixture may so hold a version the admission refuses,
 * with a record that matches it, to show what refuses it.
 */
export async function installFixture(
  built: BuiltTemplate,
  target: string,
  origin: InstalledOrigin = { kind: "shipped" },
): Promise<InstalledRecord> {
  await cp(built.folder, target, { recursive: true });
  const files: InstalledRecord["files"] = {};
  for (const member of await membersOf(target)) {
    const bytes = await readFile(path.join(target, member));
    files[member] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const measured = Object.fromEntries(Object.entries(FIXTURE_MEASUREMENTS).filter(([m]) => m in files));
  const record: InstalledRecord = {
    formatVersion: RECORD_FORMAT_VERSION,
    id: built.facts.id,
    version: built.facts.version,
    archive: { sha256: built.sha256, size: built.size },
    origin,
    files,
    measured,
  };
  await writeFile(path.join(target, RECORD_FILE), JSON.stringify(record, null, 2) + "\n");
  return record;
}

/**
 * A shipped folder at `dir`: an index listing these templates, each
 * installed at `<id>/<version>/`. Answers the folder.
 */
export async function writeShippedFolder(dir: string, templates: readonly BuiltTemplate[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const t of templates) await installFixture(t, path.join(dir, t.facts.id, String(t.facts.version)));
  const index = { formatVersion: 1, templates: templates.map((t) => ({ id: t.facts.id, version: t.facts.version })) };
  await writeFile(path.join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
  return dir;
}
