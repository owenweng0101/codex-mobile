import {test} from 'node:test';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root=fileURLToPath(new URL('../frontend/',import.meta.url));
const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
const present=['index.html','public',...Object.values(manifest.resources).map(resource=>resource.file)].every(file=>existsSync(join(root,file)));
export const hasPinnedFrontend=process.env.DSHM_TEST_PINNED!=='0'&&present;
if(process.env.DSHM_TEST_PINNED==='1'&&!present)throw Error('DSHM_TEST_PINNED=1 requires the complete reviewed local frontend snapshot; it is not downloaded or recaptured by tests.');
export const pinnedSkip=hasPinnedFrontend?false:process.env.DSHM_TEST_PINNED==='0'
  ?'Pinned DSH frontend checks explicitly disabled by DSHM_TEST_PINNED=0 (CI mode).'
  :'Reviewed pinned DSH frontend is a local ignored asset and is absent; see TESTING.md and test:pinned.';
export function pinnedTest(name,fn){return test(name,{skip:pinnedSkip},fn);}
