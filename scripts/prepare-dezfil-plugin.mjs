import { parseArgs } from 'node:util';
import { preparePackage } from './dezfil-package.mjs';

const { values } = parseArgs({ options: { output: { type: 'string' }, 'base-url': { type: 'string' } } });
if (!values.output) throw new Error('Usage: node scripts/prepare-dezfil-plugin.mjs --output <new-directory> [--base-url <origin>]');
console.log(await preparePackage({ destination: values.output, baseUrl: values['base-url'] }));
