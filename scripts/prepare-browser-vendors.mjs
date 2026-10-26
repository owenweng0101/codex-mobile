import {copyFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
const require=createRequire(new URL('../backend/package.json',import.meta.url));
const target=new URL('../backend/public/vendor/',import.meta.url);await mkdir(target,{recursive:true});
for(const [packageName,source,name]of [['marked','lib/marked.umd.js','marked.js'],['dompurify','dist/purify.min.js','purify.js'],['@xterm/xterm','lib/xterm.js','xterm.js'],['@xterm/xterm','css/xterm.css','xterm.css'],['@xterm/addon-fit','lib/addon-fit.js','xterm-fit.js']]){
 const entry=require.resolve(packageName);let directory=dirname(entry);while(!directory.endsWith(packageName)){const parent=dirname(directory);if(parent===directory)throw Error('Cannot resolve '+packageName);directory=parent;}
 await copyFile(join(directory,source),new URL(name,target));
}
