// A subprocess proof: stop exactly after the file switch, before its row.
import { productLoader } from './account-deletion-source-loader.mjs';
if (!process.env.DEZFIL_DATA_DIR?.includes('/.claude/scratch/pictures-')) throw new Error('Use an isolated picture proof directory.');
const load = productLoader(process.cwd());
const { testAccountScope } = load('lib/test-support/accounts.ts');
const { pictureTarget } = load('lib/pictures/publication.ts');
const { getPictureState } = load('lib/pictures/state.ts');
const { savePictureSet } = load('lib/map-thumbnails.ts');
const scope = testAccountScope(), id = process.argv[2], target = pictureTarget(scope, id);
await savePictureSet(scope, id, { light: Buffer.from('crash-light'), dark: Buffer.from('crash-dark') },
  { catalogue: false, datasets: [] }, target.basemaps, getPictureState(id).requestedGeneration,
  () => {}, () => { process.kill(process.pid, 'SIGKILL'); });
throw new Error('The crash boundary was not reached.');
