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
replace('proof', /<!-- contract-counts:start -->[\s\S]*?<!-- contract-counts:end -->/, '<!-- contract-counts:start -->\n' + readerCountSummary(counts) + '\n<!-- contract-counts:end -->');
assert.deepEqual(checkContractDocs(document, tools, docs), []);
for (const [name, text] of Object.entries(docs)) writeFileSync(files[name], text);
delete counts.operationsWithTools;
console.log('Regenerated the proof procedure\'s counts: ' + JSON.stringify(counts));
