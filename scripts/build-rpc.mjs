import {readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const source=new URL('../third-party/zcode-rpc/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('source.json',source),'utf8'));
for(const [path,expected] of Object.entries(manifest.files)){
 const bytes=await readFile(new URL(path,source));
 if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Upstream RPC source checksum mismatch: '+path);
}
const output=new URL('../adapter/vendor/rpc.mjs',import.meta.url);
await mkdir(new URL('.',output),{recursive:true});
await build({entryPoints:[fileURLToPath(new URL('entry.ts',source))],outfile:fileURLToPath(output),bundle:true,format:'esm',platform:'node',target:'node24',legalComments:'eof',banner:{js:'// Built from zai-org/ZCode '+manifest.revision+'. See third-party/zcode-rpc for source and licenses.'}});
console.log('RPC prepared from included open-source files; no ZCode installation required.');
