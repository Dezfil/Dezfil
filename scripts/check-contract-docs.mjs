import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { contractSource } from './contract-source.mjs';

import { HTTP_METHODS } from '../src/lib/api/http-methods.ts';
/** The committed files whose reader counts the contract holds: the two API
 * pages, and the served contract proof's procedure, which carries the counts. */
export const CONTRACT_DOCS = { api: 'docs/api/http-api.md', mcp: 'docs/api/mcp.md', proof: 'scripts/served-contract-proof.md' };
/** Those files' committed text, read from a repository root. */
export const readContractDocs = (root = '.') => Object.fromEntries(Object.entries(CONTRACT_DOCS).map(([key, file]) => [key, readFileSync(path.join(root, file), 'utf8')]));
const normalize = value => value.replace(/\s+/g, ' ').trim();
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export function measureContract(document, tools) {
  const operations = Object.entries(document.paths).flatMap(([path, item]) => Object.entries(item)
    .filter(([method]) => HTTP_METHODS.has(method)).map(([method, operation]) => ({ path, method, operation })));
  const jsonTiers = {};
  for (const { operation } of operations) {
    const limit = operation.requestBody?.['x-byte-limit'];
    if (limit !== undefined) jsonTiers[limit] = (jsonTiers[limit] ?? 0) + 1;
  }
  return {
    jsonTiers, jsonReaders: Object.values(jsonTiers).reduce((sum, count) => sum + count, 0),
    paths: Object.keys(document.paths).length, operations: operations.length,
    schemas: Object.keys(document.components.schemas).length, errors: Object.keys(document['x-error-codes']).length,
    tools: tools.length, exclusions: operations.filter(({ operation }) => operation['x-tool'] === false).length,
    operationsWithTools: operations.filter(({ operation }) => operation['x-tool'] !== false),
  };
}
export function readerCountSummary(counts) {
  const tiers = Object.entries(counts.jsonTiers).map(([limit, total]) => `${total} at ${Number(limit).toLocaleString('en-US')} bytes`).join(', ');
  return `Expected counts: ${counts.paths} paths, ${counts.operations} operations, ${counts.schemas} schemas, ${counts.errors} error codes, ${counts.tools} tools, ${counts.exclusions} exclusions and ${counts.jsonReaders} JSON readers (${tiers}).`;
}
/** Compare the committed reader text, never two newly generated summaries. */
export function checkContractDocs(document, tools, docs) {
  const measured = measureContract(document, tools), problems = [];
  const count = (label, seen, expected) => {
    if (seen === undefined || Number(seen) !== expected) problems.push(`${label}: reader says ${seen ?? 'nothing'}, contract requires ${expected}`);
  };
  const api = docs.api.match(/\*\*(\d+) paths, (\d+) operations, (\d+) named\s+component schemas\.\*\*/);
  count('API paths', api?.[1], measured.paths);
  count('API operations', api?.[2], measured.operations);
  count('API schemas', api?.[3], measured.schemas);
  count('API errors', docs.api.match(/There are \*\*(\d+)\*\* codes/)?.[1], measured.errors);
  for (const [label, expected] of [['Documented operations', measured.operations], ['Operations that become tools', measured.tools], ['Deliberately excluded', measured.exclusions]]) {
    count(`MCP ${label}`, docs.mcp.match(new RegExp(`\\| ${label} \\| (\\d+) \\|`))?.[1], expected);
  }
  const tierBlock = docs.api.match(/<!-- body-tiers:start -->([\s\S]*?)<!-- body-tiers:end -->/)?.[1] ?? '';
  const tiers = [...tierBlock.matchAll(/^\| ([\d,]+) \| (\d+) \|$/gm)].map(([, tier, count]) => [tier.replaceAll(',', ''), Number(count)]);
  if (!equal(tiers.map(([tier]) => tier).sort(), Object.keys(measured.jsonTiers).sort())) problems.push('Reader JSON tier inventory differs from contract');
  for (const [tier, expected] of Object.entries(measured.jsonTiers)) count(`JSON tier ${tier} readers`, new Map(tiers).get(tier), expected);
  count('JSON readers', docs.api.match(/Measured JSON reader operations: \*\*(\d+)\*\*/)?.[1], measured.jsonReaders);
  const catalogue = document['x-error-codes'];
  const enumCodes = document.components.schemas.Error.properties.error.properties.code.enum;
  if (!equal([...enumCodes].sort(), Object.keys(catalogue).sort())) problems.push('Error schema and source catalogue disagree');
  const block = docs.api.match(/<!-- error-catalogue:start -->([\s\S]*?)<!-- error-catalogue:end -->/)?.[1] ?? '';
  const rows = [...block.matchAll(/^\| `([^`]+)` \| (.*) \|$/gm)].map(([, code, meaning]) => [code, normalize(meaning.replaceAll('\\|', '|'))]);
  const documented = new Map(rows);
  if (rows.length !== documented.size) problems.push('Duplicate reader error catalogue entry');
  if (!equal([...documented.keys()].sort(), Object.keys(catalogue).sort())) problems.push('Reader error catalogue has missing or extra codes');
  for (const [code, meaning] of Object.entries(catalogue)) {
    if (documented.get(code) !== normalize(meaning)) problems.push(`Reader error meaning differs: ${code}`);
  }
  const contractTools = measured.operationsWithTools.map(({ path, method, operation }) => `${method} ${path} ${operation['x-tool']}`).sort();
  const derivedTools = tools.map(tool => `${tool.method} ${tool.path} ${tool.name}`).sort();
  if (!equal(contractTools, derivedTools)) problems.push('Derived tools differ from contract operations');
  const actorVariants = [
    { type: 'object', properties: { name: { type: 'string' }, sqlName: { type: 'string' } }, required: ['name', 'sqlName'], additionalProperties: false },
    { type: 'object', properties: { deleted: { type: 'boolean', const: true } }, required: ['deleted'], additionalProperties: false },
    { type: 'null' },
  ];
  const found = new Set();
  function actors(value, name) {
    if (!value || typeof value !== 'object') return;
    for (const field of ['lastChangedBy', ...(name === 'HistoryTarget' ? ['author'] : []), ...(name === 'RecipeRun' ? ['runner'] : [])]) if (value.properties?.[field]) {
      found.add(field);
      if (!equal(value.properties[field].oneOf, actorVariants)) problems.push(`Actor schema differs: ${name}.${field}`);
    }
    for (const child of Object.values(value)) actors(child, name);
  }
  for (const [name, schema] of Object.entries(document.components.schemas)) actors(schema, name);
  for (const field of ['lastChangedBy', 'author', 'runner']) if (!found.has(field)) problems.push(`Missing actor position: ${field}`);
  for (const [key, label] of [['api', 'API'], ['mcp', 'MCP']]) {
    if (!docs[key].includes('{ deleted: true }')) problems.push(`${label} actor guidance omits the deleted variant`);
  }
  const proofCounts = docs.proof?.match(/<!-- contract-counts:start -->([\s\S]*?)<!-- contract-counts:end -->/)?.[1];
  if (normalize(proofCounts ?? '') !== readerCountSummary(measured)) problems.push('Proof guide counts differ from contract');
  return problems;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { document, tools } = await contractSource();
  const root = process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : '.';
  const docs = readContractDocs(root);
  const problems = checkContractDocs(document, tools, docs);
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exitCode = 1;
  else {
    const counts = measureContract(document, tools);
    delete counts.operationsWithTools;
    console.log('PASS: reader counts and error catalogue match the contract ' + JSON.stringify(counts));
  }
}
