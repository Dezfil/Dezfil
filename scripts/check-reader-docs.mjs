import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const READER_FILES = ['README.md', 'AGENTS.md', 'docs/configuration.md', 'docs/self-hosting.md', 'docs/runbook.md', 'docs/api.md', 'docs/mcp.md', 'plugins/dezfil/skills/dezfil/analysis.md', 'src/components/settings/WorkspaceCard.tsx'];
const superseded = [
  /fuller (?:account )?documentation follows/i,
  /configured entirely through environment/i,
  /nothing is stored in the database/i,
  /nothing can be changed at runtime/i,
  /Write preconditions are not yet required/i,
  /Dezfil has no accounts|Authoring APIs are open|one shared workspace/i,
  /Members & sharing.{0,80}coming soon/i,
];
export function checkReaderDocs(files) {
  const problems = [];
  for (const file of READER_FILES) {
    const text = files[file];
    if (typeof text !== 'string') { problems.push(`Missing reader surface: ${file}`); continue; }
    for (const pattern of superseded) if (pattern.test(text.replace(/\s+/g, ' '))) problems.push(`Superseded reader copy: ${file} (${pattern.source})`);
  }
  for (const [file, revision] of [['docs/api.md', '"X-Edit-Revision": current.editRevision'], ['docs/mcp.md', 'expected_revision: current.editRevision']]) {
    const example = files[file]?.match(/<!-- revision-example -->\s*```js\n([\s\S]*?)\n```/)?.[1];
    if (!example?.includes(revision)) problems.push(`Missing revision in reader example: ${file}`);
    if (!example || (example.match(/current = await /g)?.length ?? 0) < 3) problems.push(`Missing accepted-result chaining in reader example: ${file}`);
  }
  return problems;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : process.cwd();
  const problems = checkReaderDocs(Object.fromEntries(READER_FILES.map(file => [file, readFileSync(path.join(root, file), 'utf8')])));
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exitCode = 1;
  else console.log('PASS: reader guidance and revision examples describe the shipped model');
}
