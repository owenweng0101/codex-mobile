import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean),errors=[];
for(const path of files){
 if(/(^|\/)(node_modules|runtime|\.cache|\.env)(\/|$)|config\.local\.json$|\.(?:key|pem|crt)$|(^|\/)access-token$/.test(path))errors.push(path+': private or generated path');
 if(/\.(?:png|jpg|jpeg|gif|webp|ico|woff2?)$/.test(path))continue;
 const text=await readFile(path,'utf8');
 for(const [label,pattern]of [['personal macOS path',/\/Users\/[A-Za-z0-9_.-]+/],['GitHub token',/\bgh[pousr]_[A-Za-z0-9]{30,}\b/],['private key',/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],['internal company address',/\b[A-Za-z0-9.-]+\.jd\.(?:com|cn|local)\b/]])if(pattern.test(text))errors.push(path+': '+label);
}
if(errors.length){console.error(errors.join('\n'));process.exit(1);}console.log('Public-source check passed: '+files.length+' tracked files. This is a targeted check, not a complete security audit.');
