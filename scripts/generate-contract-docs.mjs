import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { contractSource } from './contract-source.mjs';
import { CONTRACT_DOCS, measureContract, checkContractDocs, readerCountSummary } from './check-contract-docs.mjs';
const { document, tools } = await contractSource(), counts = measureContract(document, tools);
const files = CONTRACT_DOCS;
const docs = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, readFileSync(file, 'utf8')]));
function replace(key, pattern, replacement) {
  assert.ok(pattern.test(docs[key]), `Missing reader generation anchor: ${pattern}`);
  docs[key] = docs[key].replace(pattern, replacement);
}
replace('api', /\*\*\d+ paths, \d+ operations, \d+ named\s+component schemas\.\*\*/, `**${counts.paths} paths, ${counts.operations} operations, ${counts.schemas} named component schemas.**`);
replace('api', /There are \*\*\d+\*\* codes/, `There are **${counts.errors}** codes`);
replace('api', /Measured JSON reader operations: \*\*\d+\*\*/, `Measured JSON reader operations: **${counts.jsonReaders}**`);
for (const [label, key] of [['Documented operations', 'operations'], ['Operations that become tools', 'tools'], ['Deliberately excluded', 'exclusions']]) {
  replace('mcp', new RegExp(`\\| ${label} \\| \\d+ \\|`), `| ${label} | ${counts[key]} |`);
}
replace('api', /<!-- body-tiers:start -->[\s\S]*?<!-- body-tiers:end -->/, '<!-- body-tiers:start -->\n| JSON wire-byte tier | Operations |\n|---|---|\n' + Object.entries(counts.jsonTiers).map(([limit, total]) => `| ${Number(limit).toLocaleString('en-US')} | ${total} |`).join('\n') + '\n<!-- body-tiers:end -->');
replace('api', /<!-- error-catalogue:start -->[\s\S]*?<!-- error-catalogue:end -->/, '<!-- error-catalogue:start -->\n| Code | Meaning |\n|---|---|\n' + Object.entries(document['x-error-codes']).map(([code, meaning]) => `| \`${code}\` | ${meaning.replaceAll('|', '\\|')} |`).join('\n') + '\n<!-- error-catalogue:end -->');
replace('proof', /<!-- contract-counts:start -->[\s\S]*?<!-- contract-counts:end -->/, '<!-- contract-counts:start -->\n' + readerCountSummary(counts) + '\n<!-- contract-counts:end -->');
assert.deepEqual(checkContractDocs(document, tools, docs), []);
for (const [name, text] of Object.entries(docs)) writeFileSync(files[name], text);
delete counts.operationsWithTools;
console.log('Regenerated reader counts and error catalogue: ' + JSON.stringify(counts));
