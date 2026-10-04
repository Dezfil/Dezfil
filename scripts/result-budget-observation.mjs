import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

/** Calibration stays outside this interval. A fresh directory prevents stale
 * release files from silently starting a later observation. */
export async function observeRequest(directory, label, request, run) {
  if (!directory) return run();
  await mkdir(directory, { recursive: true });
  const markers = join(directory, label);
  await mkdir(markers);
  const mark = async (name, value) => {
    const file = join(markers, `${name}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify({ at: Date.now(), ...value }));
    await rename(`${file}.tmp`, file);
  };
  await mark('ready', { label, request });
  console.log(JSON.stringify({ observationReady: markers, release: join(markers, 'release') }));
  const deadline = Date.now() + 120_000;
  while (!await access(join(markers, 'release')).then(() => true, () => false)) {
    if (Date.now() >= deadline) throw new Error(`Observation release timed out: ${markers}`);
    await setTimeout(25);
  }
  await mark('started', { label });
  try {
    const result = await run();
    await mark('done', { label, status: result.status, bytes: result.bytes });
    return result;
  } catch (error) {
    await mark('done', { label, failed: true });
    throw error;
  }
}
