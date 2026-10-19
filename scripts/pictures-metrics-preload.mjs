// Proof subscriber: use only on a disposable, separately provisioned server.
import { subscribe } from 'node:diagnostics_channel';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const file = process.env.DEZFIL_PICTURE_METRICS;
if (!file || !path.basename(file).startsWith('pictures-') || !process.env.DEZFIL_DATA_DIR?.includes('/pictures-') || !process.env.PORT || process.env.PORT === '3000') throw new Error('Picture metrics require a disposable data directory, named event file and separate port.');
const write = event => appendFileSync(file, `${JSON.stringify({ ...event, pid: process.pid })}\n`, { mode: 0o600 });
write({ kind: 'boot', at: Date.now(), node: process.version, platform: process.platform, arch: process.arch,
  cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memoryBytes: os.totalmem(), chromium: process.env.DEZFIL_CHROMIUM_PATH ?? process.env.CHROMIUM_PATH ?? null,
  basemapUrl: process.env.DEZFIL_PICTURE_BASEMAP_URL, styleFixture: process.env.DEZFIL_PICTURE_STYLE_FIXTURE === '1' });
subscribe('dezfil.picture.measure', write);
