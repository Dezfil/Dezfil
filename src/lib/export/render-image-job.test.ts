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
});
