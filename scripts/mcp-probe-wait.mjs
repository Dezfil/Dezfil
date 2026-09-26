import assert from 'node:assert/strict';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(read, accepts, label, budget = 10_000) {
  const deadline = Date.now() + budget;
  for (;;) {
    const value = await read(); if (accepts(value)) return value;
    assert.ok(Date.now() < deadline, `${label} deadline (${budget} ms)`); await delay(25);
  }
}
