import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function packageTextFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Package symlink: ${file}`);
    if (entry.isDirectory()) files.push(...await packageTextFiles(file));
    else if (/\.(md|json)$/.test(file)) files.push(file);
  }
  return files;
}
export async function checkPackageCopy(root) {
  for (const file of await packageTextFiles(root)) {
    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes('—'), `Package copy contains an em dash: ${file}`);
    assert.ok(!/\b(?:never|do not|don't) (?:call|use|run) [^.\n]{0,40}(?:tool|api|operation|endpoint|\w+_\w+)/i.test(text), `API avoidance instruction: ${file}`);
  }
}
export function checkNamedOperations(skill, tools, analysis) {
  const names = new Set(tools.map(tool => tool.name));
  const mentioned = [...skill.matchAll(/`([a-z]+_[a-z_]+)`/g)].map(match => match[1]);
  const grounding = analysis.split(/^## /m).find(section => section.startsWith('external-grounding\n'));
  assert.ok(grounding, 'Missing installed external grounding');
  mentioned.push(...grounding.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g).map(match => match[0]));
  for (const name of mentioned) assert.ok(names.has(name), `Named operation absent from listing: ${name}`);
  // Independent family coverage, not just whatever names the wrapper happens to contain.
  for (const name of ['list_tables', 'inspect_table', 'get_map', 'get_layer', 'run_sql', 'create_layer', 'update_layer', 'compute_fill', 'get_history', 'undo_change', 'look_at_map', 'read_map_look_image', 'publish_map', 'import_table_from_url', 'run_operation', 'get_recipe_run']) {
    assert.ok(mentioned.includes(name), `Missing task family example: ${name}`);
  }
  return mentioned;
}
