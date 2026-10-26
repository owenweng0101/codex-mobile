import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';import {join} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
export const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const fault=(message,code)=>Object.assign(new Error(message),{code});
/** Durable at-most-once dispatch. Records contain hashes/IDs/ACK only, not text. */
export class CommandLedger{
 constructor(directory){if(!directory)throw Error('Explicit isolated ledger directory required');this.directory=directory;this.pending=new Map();}
 key(identity){return digest(identity);}
 async read(key){try{const r=JSON.parse(await readFile(join(this.directory,key+'.json'),'utf8'));if(r.version!==1||r.key!==key)throw fault('Command ledger invalid','LEDGER_CORRUPT');return r;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async save(record){const temporary=join(this.directory,'.'+record.key+'.'+randomUUID()+'.tmp'),destination=join(this.directory,record.key+'.json');let file;try{file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(record));await file.sync();await file.close();file=null;await rename(temporary,destination);const dir=await open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}}finally{await file?.close();await unlink(temporary).catch(()=>{});}}
 execute(identity,payload,operation){const key=this.key(identity),fingerprint=digest(payload);const running=this.pending.get(key);if(running){if(running.fingerprint!==fingerprint)return Promise.reject(fault('同一commandId的内容发生改变','COMMAND_ID_COLLISION'));return running.promise;}
 const promise=this.run(key,fingerprint,identity,operation).finally(()=>this.pending.delete(key));this.pending.set(key,{fingerprint,promise});return promise;}
 async run(key,fingerprint,identity,operation){await mkdir(this.directory,{recursive:true,mode:0o700});const existing=await this.read(key);if(existing){if(existing.fingerprint!==fingerprint)throw fault('同一commandId的内容发生改变','COMMAND_ID_COLLISION');return{record:existing,replayed:true};}
 let lock;try{lock=await open(join(this.directory,key+'.lock'),'wx',0o600);await lock.sync();}catch(e){if(e.code==='EEXIST')throw fault('操作正在核对，请查询原commandId，不能重新发送','COMMAND_LOCKED');throw e;}
 const record={version:1,key,fingerprint,identity,state:'prepared',createdAt:Date.now(),updatedAt:Date.now()};const checkpoint=async patch=>{Object.assign(record,patch,{updatedAt:Date.now()});await this.save(record);};
 try{const raced=await this.read(key);if(raced){if(raced.fingerprint!==fingerprint)throw fault('同一commandId的内容发生改变','COMMAND_ID_COLLISION');return{record:raced,replayed:true};}await checkpoint({state:'prepared'});await operation({record,checkpoint});return{record,replayed:false};}
 catch(error){if(record.state==='dispatched'||record.state==='prepared')await checkpoint({state:'unknown',errorCode:String(error.code||'NATIVE_OUTCOME_UNKNOWN')});throw Object.assign(error,{outcomeUnknown:record.state==='unknown',record});}
 finally{await lock.close();await unlink(join(this.directory,key+'.lock'));}}
 async status(identity){return this.read(this.key(identity));}
}
