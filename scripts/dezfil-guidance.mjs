import { GUIDANCE_SECTIONS } from '../src/lib/assistant/guidance.ts';
import { readFile } from 'node:fs/promises';

const header = '# Working with Dezfil\n\n<!-- Generated from src/lib/assistant/guidance.ts. -->\n';
const provenance = '\n## Provenance\n\nAdapted from GeoSQL `skills/geosql/SKILL.md` and\n' +
  '`skills/geosql/references/map-styling.md`, revision\n' +
  '`d2809ff65ca05b68fa423b61ad6e9f98f6d62cc6`.\n' +
  'Upstream: https://github.com/dekart-xyz/geosql.\n\n' + await readGuidanceLicense();
export function renderGuidance() {
  return header + GUIDANCE_SECTIONS.filter(section => section.audience !== 'assistant')
    .map(section => `\n## ${section.id}\n\n${section.text}\n`).join('') + provenance;
}
export function checkGuidance(installed) {
  if (installed !== renderGuidance()) throw new Error('Installed analytical guidance is stale or has divergent/audience/duplicate text');
}
export async function readGuidanceLicense() {
  const source = await readFile(new URL('../src/lib/assistant/guidance.ts', import.meta.url), 'utf8');
  return source.slice(source.indexOf(' * MIT License'), source.indexOf('\n */')).split('\n').map(line => line.replace(/^ \* ?/, '')).join('\n') + '\n';
}
