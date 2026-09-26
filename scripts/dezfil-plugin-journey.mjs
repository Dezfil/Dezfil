import { parseArgs } from 'node:util';
import { installedJourney } from './dezfil-installed-journey.mjs';
const { values } = parseArgs({ options: { installed: { type: 'string' }, 'render-log': { type: 'string' }, render: { type: 'boolean', default: false } } });
if (!values.installed) throw new Error('Usage: node scripts/dezfil-plugin-journey.mjs --installed <prepared-catalog> [--render]');
try { console.log(JSON.stringify(await installedJourney(values.installed, { render: values.render, renderLog: values['render-log'] }), null, 2)); }
catch (error) { console.error(JSON.stringify(error.journeyReport ?? { result: 'failed', error: error.message }, null, 2)); process.exitCode = 1; }
