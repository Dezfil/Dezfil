import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('packaged render destination gate', () => {
  it('runs both three-arm variants as one image step using the built artifact and a fresh store', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const imageJob = ci.slice(ci.indexOf('\n  image:'));
    const steps = imageJob.split(/\n      - /);
    const gates = steps.filter(step => step.includes('node scripts/render-egress-driver.mjs'));
    expect(gates).toHaveLength(1);
    expect(gates[0]).toContain('--image dezfil:ci');
    expect(gates[0]).toContain('DEZFIL_DATA_DIR=$(mktemp -d');
    expect(gates[0]).not.toMatch(/--victim|--suite|continue-on-error|\|\| true/);
    expect(imageJob).not.toMatch(/node scripts\/render-(?:paired-driver|comparison-seeds)\.mjs|--suite (?:matrix|tls|timing)/);
  });
  it('keeps client provisioning and the SQL byte-budget step between the render gate and transport probes', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const names = [...ci.slice(ci.indexOf('\n  image:')).matchAll(/^      - name: (.+)$/gm)].map(match => match[1]);
    const inventory = names.indexOf('Runtime image inventory matches the allowlist');
    expect(inventory).toBeGreaterThanOrEqual(0);
    expect(names.slice(inventory, inventory + 5)).toEqual([
      'Runtime image inventory matches the allowlist',
      'Render destination gate, both three-arm variants',
      'Provision the separate stock MCP probe client',
      'Source-free result-byte boundaries',
      'JSON and MCP bounds, whole uploads, paced public refusals and file limits',
    ]);
  });
  it('documents the SQL byte-budget probe in the merged image-job order', () => {
    const guide = readFileSync('docs/operate/runbook.md', 'utf8').split('### Image job probe order')[1].split('\n### ')[0];
    const rows = [...guide.matchAll(/^\| (\d+) \| (.+) \| (.+) \|$/gm)];
    expect(rows.map(row => Number(row[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(rows[1][2]).toBe('`render-egress-driver.mjs --image dezfil:ci`');
    expect(rows[2][2]).toBe('`result-budget-image.sh dezfil:ci --quick`');
    expect(rows[3][2]).toContain('`body-probe.mjs`');
  });
});
