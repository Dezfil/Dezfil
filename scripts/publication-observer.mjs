// Test-process observation only. No route, clock override or production setting.
import { appendFileSync } from 'node:fs';
const file = process.env.DEZFIL_TEST_PUBLICATION_LOG;
if (!file) throw new Error('DEZFIL_TEST_PUBLICATION_LOG is required');
appendFileSync(file, JSON.stringify({ phase: 'boot' }) + '\n');
const key = Symbol.for('dezfil.publication-windows'), set = Map.prototype.set;
Map.prototype.set = function (...args) {
  const result = set.apply(this, args);
  if (this === process[key]) appendFileSync(file, JSON.stringify({ phase: 'publication', size: this.size }) + '\n');
  return result;
};
