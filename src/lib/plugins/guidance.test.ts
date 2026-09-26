import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { GUIDANCE_SECTIONS } from '@/lib/assistant/guidance';
import { runAssistant } from '@/lib/assistant/loop';
import { PendingActionStore } from '@/lib/assistant/pending';
import { stubProvider } from '@/lib/assistant/providers/stub';
import { renderGuidance, checkGuidance } from '../../../scripts/dezfil-guidance.mjs';

const installed = () => readFileSync('plugins/dezfil/skills/dezfil/analysis.md', 'utf8');
const baseline = readFileSync('src/lib/plugins/fixtures/assistant-system.txt', 'utf8');
const assistantOnly = 'Read the grounding block before writing any SQL';
const packageOnly = 'Ground an external task in catalogue, schema and current-map reads';
const shared = 'a plain box overlap loses the matches the distance is for';
const count = (text: string, needle: string) => text.split(needle).length - 1;
async function captured() {
  const provider = stubProvider([{ text: 'Hello.', toolCalls: [] }]);
  for await (const event of runAssistant(provider, { message: 'Hi', history: [] }, { baseUrl: 'http://127.0.0.1:3390', pending: new PendingActionStore() })) void event;
  return provider.recording.exchanges[0].options.system;
}

it('2d baseline: unchanged full captured provider request bytes', async () => {
  expect(await captured()).toBe(baseline);
});
it.each(GUIDANCE_SECTIONS)('2d each section: $id has exactly its package audience count', section => {
  expect(count(installed(), section.text), section.id).toBe(section.audience === 'assistant' ? 0 : 1);
});
it('2d stale: compares the committed artifact without rewriting it', () => {
  expect(() => checkGuidance(installed())).not.toThrow();
  expect(() => checkGuidance(installed().replace(shared, 'STALE-MARKER'))).toThrow(/stale/);
});
it('2d duplicate: an independent sentence count rejects second inclusion', () => {
  expect(count(installed(), shared)).toBe(1);
  const duplicate = `${installed()}\n${shared}`;
  expect(count(duplicate, shared)).toBe(2);
  expect(() => checkGuidance(duplicate)).toThrow(/stale/);
});
it('2d audience: assistant grounding is absent from installed package', () => {
  expect(installed()).not.toContain(assistantOnly);
  expect(count(installed(), packageOnly)).toBe(1);
  expect(() => checkGuidance(`${installed()}\n${assistantOnly}`)).toThrow(/stale/);
});
it('2d audience: external grounding is absent from captured product request', async () => {
  const system = await captured(); expect(system).not.toContain(packageOnly);
  expect(count(system, assistantOnly)).toBe(1);
});
it('2d source: one canonical shared edit reaches both consumers once', async () => {
  const section = GUIDANCE_SECTIONS.find(s => s.id === 'candidate-filter')!;
  const before = section.text;
  const marker = 'SHARED-INDEPENDENT-MARKER';
  try {
    section.text += ` ${marker}`;
    const system = await captured(); const regenerated = renderGuidance();
    expect(count(system, marker)).toBe(1); expect(count(regenerated, marker)).toBe(1);
    expect(() => checkGuidance(installed())).toThrow(/stale/);
    expect(() => checkGuidance(regenerated)).not.toThrow();
    expect(system).not.toContain(packageOnly); expect(regenerated).not.toContain(assistantOnly);
  } finally { section.text = before; }
});
