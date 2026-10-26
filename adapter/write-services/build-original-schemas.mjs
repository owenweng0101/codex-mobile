import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const source=new URL('../../vendor/zcode-web/remote/v4/3.16.3/assets/parts-BD-IKHpw.js',import.meta.url),raw=await readFile(source,'utf8');
let output=raw,count=0;output=output.replace(/from"\.\/([^"\n]+)"/g,(_,name)=>{count++;return 'from"../../../vendor/zcode-web/remote/v4/3.16.3/assets/'+name+'"';});
if(count!==3)throw Error('Original schema dependency count changed');
output+='\n// Export original existing schemas for server adapter contract validation.\nexport {An as originalCommandPayloads,In as originalCommandAck,jn as originalCommandTypes};\n';
await writeFile(new URL('./vendor/original-command-schemas.mjs',import.meta.url),output);
await writeFile(new URL('./vendor/schema-manifest.json',import.meta.url),JSON.stringify({originalSha256:createHash('sha256').update(raw).digest('hex'),outputSha256:createHash('sha256').update(output).digest('hex'),importLocationReplacements:count,addedExports:['An','In','jn'],uiOrSchemaLogicReplacements:0},null,2)+'\n');
