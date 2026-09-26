import { mkdtemp } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { packageScenario } from './dezfil-package-scenario.mjs';
const { values } = parseArgs({ options: { origin: { type: 'string' }, render: { type: 'boolean' }, 'render-log': { type: 'string' } } });
if (!values.origin) throw new Error('Explicit isolated instance origin required');
try { console.log(JSON.stringify(await packageScenario(await mkdtemp('/tmp/dezfil-plugin-'), values.origin, { render: values.render, renderLog: values['render-log'] }), null, 2)); }
catch (error) { console.error(JSON.stringify(error.scenarioReport ?? error.journeyReport ?? { result: 'failed', error: error.message }, null, 2)); process.exitCode = 1; }
