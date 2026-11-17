import {spawnSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function discoverTests(base=root){
 const groups=['scripts/test','connection/test','adapter/test','adapter/read-services/test','adapter/write-services','adapter/frontend-stage','backend/test','dsh-mobile/test','claude-mobile/test','claude-mobile/desktop-plugin/tests','desktop/mobile-qr'];
 const files=[];for(const group of groups)for(const file of (await readdir(resolve(base,group))).sort())
  if(file.endsWith('.test.mjs')&&!file.includes('-real.'))files.push(group+'/'+file);
 return files;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const files=await discoverTests();
 const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{cwd:root,env:{...process.env,DSHM_TEST_PINNED:process.env.DSHM_TEST_PINNED??'0'},stdio:'inherit'});
 process.exit(result.status??1);
}
