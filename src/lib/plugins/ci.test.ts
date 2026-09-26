import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const steps = workflow.split('      - name: ');
const step = (name: string) => steps.find(text => text.startsWith(`${name}\n`));
it('4c/4d: HTTP and rendering have separate exit codes', () => {
  const http = step('Installed plugin HTTP journey');
  const render = step('Installed plugin real retained map check');
  expect(http, 'dedicated HTTP step').toBeDefined();
  expect(http).not.toContain('--render');
  expect(render, 'dedicated render step').toContain('--render --render-log');
});
it('a render failure cannot skip either offline gate', () => {
  const render = step('Installed plugin real retained map check');
  expect(render, 'dedicated render step').toBeDefined();
  for (const gate of ['Offline boot and image export render data pixels', 'Browser-removed negative — export fails coded, health green']) {
    expect(steps.indexOf(render!), gate).toBeGreaterThan(steps.indexOf(step(gate)!));
  }
  const cleanup = step('Stop plugin journey container');
  expect(steps.indexOf(cleanup!)).toBeGreaterThan(steps.indexOf(render!));
  expect(cleanup).toContain('if: always()');
});
