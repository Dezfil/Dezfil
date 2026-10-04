import { createHash } from 'node:crypto';
import { checkContractDocs, measureContract } from './check-contract-docs.mjs';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Inputs are actual HTTP/SDK observations and committed artifacts, never regenerated readers. */
export function checkServedContract({ document, sourceDocument, tools, derivedTools, docs, baseline, guidance, expectedGuidance }) {
  const problems = checkContractDocs(document, derivedTools, docs);
  if (!same(document, sourceDocument)) problems.push('Served OpenAPI differs from candidate source');
  const names = tools.map(tool => tool.name).sort();
  if (!same(names, derivedTools.map(tool => tool.name).sort())) problems.push('Served MCP tool identities differ');
  if (tools.length !== baseline.count) problems.push('Served MCP count differs from committed capture');
  for (const tool of tools) if (digest(tool) !== baseline.tools[tool.name]) problems.push(`Served MCP definition differs: ${tool.name}`);
  if (guidance !== expectedGuidance) problems.push('Installed plugin guidance is stale');
  return problems;
}
export function servedCounts(document, tools) {
  const counts = measureContract(document, tools); delete counts.operationsWithTools; return counts;
}
