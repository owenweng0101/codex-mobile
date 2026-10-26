import {spawnSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
const groups=['connection/test','adapter/test','adapter/read-services/test','adapter/write-services','adapter/frontend-stage','backend/test'];
const files=[];for(const group of groups)for(const file of await readdir(group)){if(file.endsWith('.test.mjs')&&!file.includes('-real.')&&!['update-preflight.test.mjs'].includes(file))files.push(group+'/'+file);}
const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{stdio:'inherit'});process.exit(result.status??1);
