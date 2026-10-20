// The settings tables: one table per area of settings, generated from the
// settings catalogue that Settings itself reads, and written into the pages
// between `<!-- name:start -->` and `<!-- name:end -->` by
// `npm run docs:write`. `npm run lint:docs` fails a table that differs from
// what the catalogue generates, one that is missing from its page, and one
// on a page it does not belong to.
//
// Each row gives the setting as Settings names it, its environment variable
// and its Settings key where each applies, the default with its unit, the
// values it takes, what it does, and how each way of changing it takes
// effect: a change in Settings at once, a variable after a restart.
//
// The areas follow Settings: a tab, or for the settings a variable alone
// sets, the part of the instance they belong to. The assistant's table goes
// on Set up the assistant, the trusted proxies' on Reverse proxy and HTTPS,
// the limits an operator changes on Limits, and every other area on a page
// of its own under docs/self-host/configuration/. The test wiring goes on
// Development setup. The configuration guard (check-readme-config.mjs)
// reads the tables as written and holds them to the catalogue on its own.

/** The catalogue's settings the server code reads as test seams, not as
 * operator settings: they are documented with the test wiring. */
export const TEST_SEAMS = ["overtureS3Endpoint"];

/** The areas, each with the page its table is on and its table's name. */
export const SETTINGS_AREAS = [
  { id: "general", page: "docs/self-host/configuration/general.md" },
  { id: "defaults", page: "docs/self-host/configuration/defaults.md" },
  { id: "libraries", page: "docs/self-host/configuration/libraries.md" },
  { id: "services", page: "docs/self-host/configuration/services.md" },
  { id: "rules", page: "docs/self-host/configuration/rules.md" },
  { id: "storage", page: "docs/self-host/configuration/storage.md" },
  { id: "assistant", page: "docs/self-host/assistant.md" },
  { id: "proxies", page: "docs/self-host/reverse-proxy.md" },
  { id: "limits", page: "docs/api/limits.md" },
].map((area) => ({ ...area, table: `settings-${area.id}` }));

/** The test wiring's table: the names the tests, the helper scripts and the
 * server's test seams read. */
export const WIRING_TABLE = { id: "test-wiring", page: "docs/contribute/development-setup.md", table: "test-wiring" };

/** The settings a variable sets, by area. Settings an admin stores with no
 * variable follow the catalogue's own groups. */
const BY_AREA = {
  assistant: ["anthropicApiKey", "openaiApiKey", "aiProvider", "aiModel", "aiModelsAnthropic", "aiModelsOpenai", "assistantOffer",
    "assistantAutoCheck", "assistantStepBudget", "assistantLookTimeoutS", "assistantLookRetention", "assistantLookRetentionMb"],
  proxies: ["trustedProxies", "sessionCookie"],
  storage: ["dataDir", "secretKey", "tippecanoe", "chromiumPath"],
  libraries: ["basemapUrl", "basemapAttribution", "satelliteUrl", "satelliteAttribution"],
  services: [
    "geocoderUrl", "geocodePaceMs", "geocodeRequestTimeoutS", "geocodeMatchCacheHours", "geocodeNoMatchCacheHours", "geocodeCacheMb",
    "isochroneUrl", "isochronePaceMs", "isochroneRequestTimeoutS", "isochroneCacheHours", "isochroneCacheMb",
    "overpassUrl", "overpassTimeoutS", "overpassMaxsizeMb", "overpassCacheHours", "overpassCacheMb",
    "s3Endpoint", "objectStoreCredentials", "templatesCatalogueUrl", "egressAllowlist",
  ],
};

/** Where an area's table does not follow the catalogue's order, the order
 * Settings draws it in: Libraries' basemap switches, then the satellite
 * imagery, then the deployment's own basemap; Data & services' cards, each
 * service's settings together, then the templates and the private network.
 * The Limits table follows the Limits tab. A setting not listed comes after,
 * in the catalogue's order. */
const ORDER = {
  libraries: ["basemaps.dark", "basemaps.light", "basemaps.streets", "basemaps.satellite", "basemaps.singleMapStyles",
    "satelliteUrl", "satelliteAttribution", "basemapUrl", "basemapAttribution"],
  services: [
    "geocoderUrl", "geocodePaceMs", "geocodeRequestTimeoutS", "geocodeMatchCacheHours", "geocodeNoMatchCacheHours", "geocodeCacheMb",
    "isochroneUrl", "isochronePaceMs", "isochroneRequestTimeoutS", "isochroneCacheHours", "isochroneCacheMb",
    "overpassUrl", "overpassTimeoutS", "overpassMaxsizeMb", "overpassCacheHours", "overpassCacheMb",
    "s3Endpoint", "objectStoreCredentials", "templates.catalogue", "templatesCatalogueUrl", "egressAllowlist",
  ],
};

/** The area a setting's row is in, or null for what no table lists: an
 * account's own preferences and the platform's plumbing. Undefined for a
 * setting no area takes, which the generator refuses. `predicates` are the
 * catalogue's own: which settings are what new things start with, the
 * rules, the basemap switches and the template catalogue's. */
export function areaOf(definition, predicates) {
  if (definition.scope === "account" || definition.scope === "platform") return null;
  if (TEST_SEAMS.includes(definition.key)) return WIRING_TABLE.id;
  for (const [area, keys] of Object.entries(BY_AREA)) if (keys.includes(definition.key)) return area;
  if (predicates.isInstanceDefault(definition)) return "defaults";
  if (predicates.isInstanceRule(definition)) return "rules";
  if (predicates.isLibrarySwitch(definition)) return "libraries";
  if (predicates.isTemplatesSetting(definition)) return "services";
  if (!definition.environment && !definition.key.includes(".")) return "general";
  if (definition.environment && definition.kind === "number") return "limits";
  return undefined;
}

/** What a variable takes, for the settings no write rule of Settings
 * describes: read from the code that parses each one. */
const VARIABLE_VALUES = {
  assistantAutoCheck: "`0`, `false` or `off` turns it off; any other value turns it on",
  dataDir: "A folder path",
  secretKey: "64 hex characters (32 bytes)",
  trustedProxies: "IP addresses or CIDR networks, separated by commas or spaces; a host name stops the server at start",
  sessionCookie: "ASCII letters, digits and ``!#$%&'*+-.^_`|~``; any other value stops the server at start",
  egressAllowlist: "Host names, IP addresses or CIDR networks, separated by commas",
  objectStoreCredentials: "`1`, `true` or `yes` turns it on; any other value leaves it off",
  tippecanoe: "A program name, looked up on `PATH`, or a path to the program",
  basemapUrl: "A MapLibre style address",
  basemapAttribution: "Text",
  anthropicApiKey: "An Anthropic API key",
  openaiApiKey: "An OpenAI API key",
  aiProvider: "`anthropic` or `openai`; any other value leaves the assistant off",
  aiModel: "A model id the provider offers",
  aiModelsAnthropic: "Model ids, separated by commas; set and empty, only the default",
  aiModelsOpenai: "Model ids, separated by commas; set and empty, only the default",
  assistantOffer: "`subset` or `full`; any other value reads as `subset`",
  chromiumPath: "A path to a headless Chromium or Chrome",
};

const grouped = (value) => (typeof value === "number" ? value.toLocaleString("en-US") : String(value));
const code = (value) => `\`${value}\``;
const joined = (word) => (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${word} ${items.at(-1)}`);
const either = joined("or");
const all = joined("and");

/** What Settings takes for a setting, from its write rule. */
function writeValues(write) {
  switch (write.kind) {
    case "integer": return `A whole number from ${grouped(write.min)} to ${grouped(write.max)}`;
    case "decimal": return `A number from ${grouped(write.min)} to ${grouped(write.max)}`;
    case "switch": return "`true` or `false`";
    case "choice": return either(write.values.map(code));
    case "text": return `Text, up to ${grouped(write.maxLength)} characters`;
    case "sites": return `Up to ${grouped(write.maxSites)} sites, each \`http\` or \`https\` with a host and an optional port`;
    case "address": {
      let text = `An \`http\` or \`https\` address, up to ${grouped(write.maxLength)} characters`;
      if (write.placeholders?.length) text += `, holding ${all(write.placeholders.map(code))}`;
      if (write.userInformation === "refused") text += ", with no user name or password";
      return text;
    }
    default: throw new Error(`No words for the write rule ${write.kind}`);
  }
}

/** What a numeric variable takes, from how the server parses it, and how
 * it is taken. */
function numberValues(parsing) {
  if (parsing === "non-negative") return ["any number from 0", ""];
  if (parsing === "positive-integer") return ["any number above 0", ", rounded down to a whole number of at least 1"];
  return ["any number above 0", ""];
}

/** The values a setting takes, each way it is set. `drawn` is the number
 * row of the tab that draws it, where the tab types it in a unit of its own
 * (the gaps in seconds, the freshness in days): Settings' range is then
 * given in that unit, and the variable's in the catalogue's. Settings'
 * rules for text and addresses bind what Settings saves; a variable is
 * taken as it is, trimmed. */
export function valuesOf(definition, drawn) {
  const settings = definition.editable && definition.write ? writeValues(definition.write) : null;
  if (definition.kind === "number" && definition.environment) {
    const [variable, taken] = numberValues(definition.parsing);
    if (!settings) return `${variable.charAt(0).toUpperCase()}${variable.slice(1)}${taken}`;
    if (drawn && drawn.scale !== 1) {
      const range = `${grouped(definition.write.min / drawn.scale)} to ${grouped(definition.write.max / drawn.scale)} ${drawn.unit}`;
      return `${range} in Settings; ${variable}, in ${definition.unit}, as a variable${taken}`;
    }
    return `${settings.replace(/^A (?:whole )?number from /, "")} in Settings; ${variable} as a variable${taken}`;
  }
  if (settings && definition.environment && definition.write.kind === "address") {
    const folder = definition.write.folder === "variable" ? "any address, or a folder on the server," : "any address";
    return `${settings}, in Settings; ${folder} as a variable`;
  }
  if (settings && definition.environment && definition.write.kind === "text") return `${settings}, in Settings; any text as a variable`;
  if (settings) return settings;
  if (Object.hasOwn(VARIABLE_VALUES, definition.key)) return VARIABLE_VALUES[definition.key];
  throw new Error(`No words for the values of ${definition.environment ?? definition.key}: describe them in scripts/settings-tables.mjs`);
}

/** Whether the documented default is the value itself, set as code, rather
 * than words about it (unset, generated, on). */
function literalDefault(definition) {
  const value = definition.defaultValue;
  return (typeof value === "number" || (typeof value === "string" && value !== "")) && String(value) === definition.documentedDefault;
}

/** The default with its unit, as Settings shows the unit. */
export function defaultOf(definition, unitOf) {
  const unit = unitOf(definition);
  const value = literalDefault(definition) ? code(definition.documentedDefault) : definition.documentedDefault;
  return unit ? `${value} ${unit}` : value;
}

/** How each way of changing a setting takes effect. */
export function changesOf(definition) {
  const ways = [];
  if (definition.editable) ways.push(`in Settings, ${definition.timing === "live" ? "live" : "after a restart"}`);
  if (definition.environment) ways.push(`by variable, ${definition.environmentTiming === "restart" ? "after a restart" : "live"}`);
  const text = ways.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The tabs of Settings that draw instance settings, each with its cards
 * and their rows under the labels the tab shows, from the modules the tabs
 * draw from: `source.general`, `source.defaults`, `source.libraries`,
 * `source.data`, `source.security` and `source.limits`. A row draws one
 * setting, or several side by side, each then named by its own label. */
export function drawnTabs(source) {
  const { general, defaults, libraries, data, security, limits } = source;
  const own = (card) => ({ title: card.title, rows: card.rows.map((row) => ({ label: row.label, fields: row.fields })) });
  const single = (label, key) => ({ label, fields: [{ key }] });
  const dataCard = (card) => data.isTemplatesCard(card)
    ? { title: card.title, rows: [single(card.catalogue.label, card.catalogue.key), single(card.address.label, card.address.key)] }
    : { title: card.title, rows: card.rows.filter((row) => ["address", "number", "locked"].includes(row.kind)).map((row) => single(row.label, row.key)) };
  return [
    { tab: "General", cards: general.GENERAL_CARDS.map((card) => ({ title: card.title, rows: card.rows.map((row) => single(row.label, row.key)) })) },
    { tab: "Maps", cards: defaults.DEFAULTS_TABS.maps.map(own) },
    { tab: "Workflows & SQL", cards: defaults.DEFAULTS_TABS.workflows.map(own) },
    { tab: "Publishing", cards: [...defaults.DEFAULTS_TABS.publishing, security.PUBLIC_LINKS_CARD].map(own) },
    { tab: "Security", cards: security.SECURITY_CARDS.map(own) },
    { tab: "Libraries", cards: [
      { title: libraries.BASEMAPS_CARD.title, rows: [
        ...libraries.BUILT_IN_STYLES.map((row) => single(row.label, row.setting)),
        single(libraries.SINGLE_MAP_ROW.label, libraries.SINGLE_MAP_ROW.key),
      ] },
      { title: libraries.SATELLITE_CARD.title, rows: [
        single(libraries.SATELLITE_ADDRESS_ROW.label, libraries.SATELLITE_ADDRESS_ROW.key),
        single(libraries.SATELLITE_CREDIT_ROW.label, libraries.SATELLITE_CREDIT_ROW.key),
      ] },
    ] },
    { tab: "Data & services", cards: [...data.dataTabCards().map(dataCard), own(security.CONNECTIONS_CARD)] },
    { tab: "Limits", cards: limits.LIMITS_CARDS.map((card) => ({ title: card.title,
      rows: card.rows.filter((row) => row.kind === "setting").map((row) => single(row.label, row.key)) })) },
  ];
}

/** Each drawn setting's name as its tab shows it, by key: its row's label,
 * then its own label where the row draws several. The card's title goes in
 * front where that label is one word, or where it names more than one row
 * of the tab, so the name says which card to open. */
export function drawnLabels(tabs) {
  const labels = new Map();
  for (const { tab, cards } of tabs) {
    const rows = cards.flatMap((card) => card.rows);
    const count = (label) => rows.filter((row) => row.label === label).length;
    for (const card of cards) for (const row of card.rows) for (const field of row.fields) {
      let parts = row.fields.length > 1 && field.label ? [row.label, field.label] : [row.label];
      if (parts.length === 1 && (!/\s/.test(parts[0]) || count(parts[0]) > 1)) parts = [card.title, ...parts];
      if (labels.has(field.key)) throw new Error(`Two rows of Settings draw ${field.key}: ${labels.get(field.key).tab} and ${tab}`);
      labels.set(field.key, { tab, parts });
    }
  }
  return labels;
}

const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");

export const SETTINGS_HEADER = ["Setting", "Variable", "Settings key", "Default", "Values", "What it does", "Changes"];
export const WIRING_HEADER = ["Variable", "Default", "What it does"];

function table(header, rows) {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

/** Every table, from the catalogue and what Settings shows beside it:
 * `source.catalogue` is the catalogue module (its settings, its test wiring
 * and its predicates), `source.limits` the Limits tab's (its cards, the
 * labels and units its rows take), and the other tabs' modules (see
 * drawnTabs) give the labels each tab draws its settings under. A setting
 * no tab draws, which a variable alone sets, is named as System's Server
 * settings card names it. Each table comes with its page and its rows'
 * names, a variable or a Settings key. */
export function settingsTables(source) {
  const { SETTING_CATALOGUE, TEST_WIRING } = source.catalogue;
  const predicates = source.catalogue;
  const { LIMITS_CARDS, shownUnit } = source.limits;
  const drawn = drawnLabels(drawnTabs(source));
  const labelOf = (definition) => {
    const parts = drawn.get(definition.key)?.parts;
    if (!parts && definition.editable) throw new Error(`No tab of Settings draws ${definition.key}: add its row to drawnTabs in scripts/settings-tables.mjs`);
    return (parts ?? [definition.label]).map((part) => `**${part}**`).join(" › ");
  };
  const unitOf = (definition) => shownUnit(definition.key, definition.unit);
  const typedIn = new Map(source.data.serviceNumberRows().map((row) => [row.key, row]));
  const members = new Map([...SETTINGS_AREAS, WIRING_TABLE].map((area) => [area.id, []]));
  for (const definition of SETTING_CATALOGUE) {
    const area = areaOf(definition, predicates);
    if (area === null) continue;
    if (area === undefined) throw new Error(`No settings table takes ${definition.environment ?? definition.key}: give it an area in scripts/settings-tables.mjs`);
    members.get(area).push(definition);
  }
  // The Limits tab's rows in its order, then the variables beside them; the
  // listed areas in their lists' order; the rest in the catalogue's.
  const limitsOrder = LIMITS_CARDS.flatMap((card) => card.rows).filter((row) => row.kind === "setting").map((row) => row.key);
  const rank = (area, definition) => {
    const list = area === "limits" ? limitsOrder : ORDER[area] ?? BY_AREA[area] ?? [];
    const at = list.indexOf(definition.key);
    return at === -1 ? list.length + SETTING_CATALOGUE.indexOf(definition) : at;
  };
  const tables = SETTINGS_AREAS.map((area) => {
    const rows = [...members.get(area.id)].sort((a, b) => rank(area.id, a) - rank(area.id, b));
    return {
      ...area,
      names: rows.map((definition) => definition.environment ?? definition.key),
      markdown: table(SETTINGS_HEADER, rows.map((definition) => [
        labelOf(definition),
        definition.environment ? code(definition.environment) : "",
        definition.editable ? code(definition.key) : "",
        defaultOf(definition, unitOf),
        valuesOf(definition, typedIn.get(definition.key)),
        definition.purpose,
        changesOf(definition),
      ])),
    };
  });
  const wiring = [...TEST_WIRING, ...members.get(WIRING_TABLE.id)];
  tables.push({
    ...WIRING_TABLE,
    names: wiring.map((entry) => entry.environment),
    markdown: table(WIRING_HEADER, wiring.map((entry) => [code(entry.environment), entry.documentedDefault, entry.purpose])),
  });
  return tables;
}

// ---------------------------------------------------------------------------
// The tables in the pages

const START = /^<!--\s*([A-Za-z0-9_-]+):start\s*-->\s*$/;
const END = /^<!--\s*([A-Za-z0-9_-]+):end\s*-->\s*$/;

/** Whether a generated region's name is a settings table's. */
export const isTableName = (name) => name.startsWith("settings-") || name === WIRING_TABLE.table;

/** The settings tables' regions in a page's text: each with its name, the
 * lines of its markers (1-based) and what it holds between them. Code
 * fences are skipped, so a marker shown in a code block is no region. */
export function tableRegions(text) {
  const lines = text.split("\n");
  const regions = [];
  let fence = null, open = null;
  lines.forEach((line, i) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && line.trim() === marker[1]) fence = null; return; }
    if (marker) { fence = marker[1]; return; }
    const start = START.exec(line), end = END.exec(line);
    if (start && isTableName(start[1])) {
      if (open) regions.push({ ...open, end: null });
      open = { name: start[1], start: i + 1 };
    } else if (end && open && end[1] === open.name) {
      regions.push({ ...open, end: i + 1, content: lines.slice(open.start, i).join("\n") });
      open = null;
    }
  });
  if (open) regions.push({ ...open, end: null });
  return regions;
}

/** What a table's region holds: the table, with a blank line on each side. */
const regionContent = (markdown) => `\n${markdown}\n`;

const problem = (file, rule, message, line) => ({ file, rule, message, ...(line ? { line } : {}) });

/** The tables' problems in the pages: each table on its page, once, as the
 * catalogue generates it, and no table on a page it does not belong to.
 * `files` lists the repository's files and `read` returns one's text. */
export function checkSettingsTables({ files, read, tables }) {
  const problems = [];
  const fileSet = new Set(files);
  const byName = new Map(tables.map((entry) => [entry.table, entry]));
  const pages = files.filter((file) => /^docs\/.+\.md$/.test(file) && file !== "docs/README.md").sort();
  const found = new Map();
  for (const file of pages) {
    for (const region of tableRegions(read(file))) {
      const expected = byName.get(region.name);
      if (region.end === null) { problems.push(problem(file, "settings.unclosed-table", `the ${region.name} table opens here and is never closed with <!-- ${region.name}:end -->`, region.start)); continue; }
      if (!expected || expected.page !== file) {
        problems.push(problem(file, "settings.unknown-table", expected
          ? `the ${region.name} table belongs on ${expected.page}`
          : `${region.name} is not a settings table the catalogue generates`, region.start));
        continue;
      }
      if (found.has(region.name)) { problems.push(problem(file, "settings.duplicate-table", `the ${region.name} table is on this page twice`, region.start)); continue; }
      found.set(region.name, region);
      if (region.content !== regionContent(expected.markdown)) {
        problems.push(problem(file, "settings.stale", `the ${region.name} table differs from what the settings catalogue generates; run npm run docs:write`, region.start));
      }
    }
  }
  for (const entry of tables) {
    if (found.has(entry.table)) continue;
    if (!fileSet.has(entry.page)) problems.push(problem(entry.page, "settings.missing-page", `the page for the ${entry.table} table does not exist`));
    else problems.push(problem(entry.page, "settings.missing-table", `the page holds no ${entry.table} table; put <!-- ${entry.table}:start --> and <!-- ${entry.table}:end --> where it goes, then run npm run docs:write`));
  }
  return problems;
}

/** Write each table into its page, between its markers. A page without the
 * markers is left as it is, for the check to name. Returns the pages
 * written. */
export function writeSettingsTables({ files, read, write, tables }) {
  const written = [];
  const fileSet = new Set(files);
  for (const entry of tables) {
    if (!fileSet.has(entry.page)) continue;
    const text = read(entry.page);
    const region = tableRegions(text).find((r) => r.name === entry.table && r.end !== null);
    if (!region) continue;
    const lines = text.split("\n");
    const next = [...lines.slice(0, region.start), ...regionContent(entry.markdown).split("\n"), ...lines.slice(region.end - 1)].join("\n");
    if (next !== text) { write(entry.page, next); written.push(entry.page); }
  }
  return written;
}
