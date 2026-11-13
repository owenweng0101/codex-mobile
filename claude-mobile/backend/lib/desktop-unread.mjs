import {readFileSync,readdirSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const DIRECTORY=join(homedir(),'Library/Application Support/Claude-3p/Local Storage/leveldb');
const KEY=Buffer.from('_app://localhost\0\x01epitaxy-unread-v1','utf8');
const LIMIT=64*1024*1024,MAX_SEQUENCE=(1n<<56n)-1n;
const requireValid=condition=>{if(!condition)throw Error('Invalid LevelDB snapshot');};
const cursor=b=>({b,p:0,end:b.length});
function take(c,n){
  requireValid(Number.isSafeInteger(n)&&n>=0&&n<=c.end-c.p);
  const value=c.b.subarray(c.p,c.p+n);c.p+=n;return value;
}
function variable(c){
  let value=0n;
  for(let i=0;i<10;i++){
    const byte=take(c,1)[0];value|=BigInt(byte&127)<<BigInt(i*7);
    if(!(byte&128)){requireValid(value<=BigInt(Number.MAX_SAFE_INTEGER));return Number(value);}
  }
  throw Error('Invalid LevelDB varint');
}
const string=c=>take(c,variable(c));
const crcTable=Uint32Array.from({length:256},(_,i)=>{
  for(let j=0;j<8;j++)i=(i>>>1)^((i&1)?0x82f63b78:0);return i>>>0;
});
function checksum(bytes){
  let crc=0xffffffff;for(const byte of bytes)crc=(crc>>>8)^crcTable[(crc^byte)&255];
  crc=(~crc)>>>0;return (((crc>>>15)|(crc<<17))+0xa282ead8)>>>0;
}
function snappy(bytes){
  const c=cursor(bytes),size=variable(c);requireValid(size<=LIMIT);
  const out=Buffer.alloc(size);let p=0;
  while(c.p<c.end){
    const tag=take(c,1)[0],type=tag&3;let length=(tag>>>2)+1,offset;
    if(type===0){
      if(length>60)length=take(c,length-60).readUIntLE(0,length-60)+1;
      requireValid(length<=size-p);take(c,length).copy(out,p);p+=length;continue;
    }
    if(type===1){length=4+((tag>>>2)&7);offset=((tag&224)<<3)|take(c,1)[0];}
    else offset=take(c,type===2?2:4).readUIntLE(0,type===2?2:4);
    requireValid(offset>0&&offset<=p&&length<=size-p);
    for(let i=0;i<length;i++){out[p]=out[p-offset];p++;}
  }
  requireValid(p===size);return out;
}
function entries(bytes,visit){
  requireValid(bytes.length>=8);
  const count=bytes.readUInt32LE(bytes.length-4);
  requireValid(count>0&&count<=(bytes.length-4)/4);
  const end=bytes.length-4-count*4,restarts=[];
  for(let i=0;i<count;i++){
    const offset=bytes.readUInt32LE(end+4*i);
    requireValid(i===0?offset===0:offset>restarts[i-1]);
    requireValid(offset<end||(end===0&&count===1&&offset===0));restarts.push(offset);
  }
  const c={b:bytes,p:0,end};let previous=Buffer.alloc(0),restart=0;
  while(c.p<end){
    const start=c.p,shared=variable(c),length=variable(c),valueLength=variable(c);
    requireValid(shared<=previous.length&&shared+length<=LIMIT);
    if(restarts[restart]===start){requireValid(shared===0);restart++;}
    else requireValid(restart===count||restarts[restart]>start);
    const key=Buffer.concat([previous.subarray(0,shared),take(c,length)]);
    visit(key,take(c,valueLength));previous=key;
  }
  requireValid(end===0||restart===count);
}
function table(bytes,visit){
  requireValid(bytes.length>=48&&bytes.readBigUInt64LE(bytes.length-8)===0xdb4775248b80fb57n);
  const footer=cursor(bytes.subarray(bytes.length-48,bytes.length-8));
  const handle=c=>({offset:variable(c),size:variable(c)});
  handle(footer);const index=handle(footer);
  const block=({offset,size})=>{
    requireValid(size<=LIMIT&&offset<=bytes.length-48&&size+5<=bytes.length-48-offset);
    const type=bytes[offset+size],raw=bytes.subarray(offset,offset+size);
    requireValid(checksum(bytes.subarray(offset,offset+size+1))===bytes.readUInt32LE(offset+size+1));
    requireValid(type===0||type===1);return type===1?snappy(raw):raw;
  };
  entries(block(index),(_key,value)=>{
    const c=cursor(value),location=handle(c);requireValid(c.p===c.end);
    entries(block(location),(key,data)=>{
      requireValid(key.length>=8);
      const tag=key.readBigUInt64LE(key.length-8),type=Number(tag&255n);
      requireValid(type===1||(type===0&&data.length===0));
      if(key.subarray(0,-8).equals(KEY))visit(tag>>8n,type,data);
    });
  });
}
function batch(bytes,visit){
  const c=cursor(bytes),sequence=take(c,8).readBigUInt64LE(),count=take(c,4).readUInt32LE();
  requireValid(sequence<=MAX_SEQUENCE&&count<=c.end-c.p&&sequence+BigInt(Math.max(0,count-1))<=MAX_SEQUENCE);
  for(let i=0;i<count;i++){
    const type=take(c,1)[0];requireValid(type===0||type===1);
    const key=string(c),value=type===1?string(c):Buffer.alloc(0);
    if(key.equals(KEY))visit(sequence+BigInt(i),type,value);
  }
  requireValid(c.p===c.end);
}
function wal(bytes,visit){
  let fragments=null;
  for(let p=0;p<bytes.length;){
    const end=Math.min(bytes.length,(Math.floor(p/32768)+1)*32768);
    if(end-p<7){
      requireValid(end%32768===0&&bytes.subarray(p,end).every(b=>b===0));p=end;continue;
    }
    const crc=bytes.readUInt32LE(p),length=bytes.readUInt16LE(p+4),type=bytes[p+6];
    if(crc===0&&length===0&&type===0){
      requireValid(bytes.subarray(p,end).every(b=>b===0));p=end;continue;
    }
    requireValid(length<=end-p-7&&type>=1&&type<=4);
    requireValid(checksum(bytes.subarray(p+6,p+7+length))===crc);
    const data=bytes.subarray(p+7,p+7+length);p+=7+length;
    if(type===1){requireValid(fragments===null);batch(data,visit);}
    else if(type===2){requireValid(fragments===null);fragments=[data];}
    else{
      requireValid(fragments!==null);fragments.push(data);
      if(type===4){batch(Buffer.concat(fragments),visit);fragments=null;}
    }
  }
  requireValid(fragments===null);
}
function snapshot(directory){
  return readdirSync(directory).filter(name=>/^\d+\.(log|ldb|sst)$/.test(name)).sort().map(name=>{
    const s=statSync(join(directory,name),{bigint:true});
    requireValid(s.isFile()&&s.size<=BigInt(LIMIT));
    return [name,[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':')];
  });
}

/** Strictly read-only; never opens LevelDB, its LOCK, or any writable handle.
 * Only the target value is decoded. No cache: every call sees file changes.
 * Missing/invalid/unstable snapshots are unknown; a tombstone is known-empty.
 */
export function readDesktopUnread({directory=DIRECTORY,withRevision=false}={}){
  const empty=(known,revision=null)=>({known,unreadIds:new Set(),explicitUnreadIds:new Set(),...(withRevision?{revision}:{})});
  try{
    const before=snapshot(directory);let latest=null;
    const visit=(sequence,type,value)=>{
      if(latest&&sequence===latest.sequence)
        requireValid(type===latest.type&&value.equals(latest.value));
      if(!latest||sequence>latest.sequence)latest={sequence,type,value};
    };
    for(const [name] of before){
      const bytes=readFileSync(join(directory,name));requireValid(bytes.length<=LIMIT);
      if(name.endsWith('.log'))wal(bytes,visit);else table(bytes,visit);
    }
    requireValid(JSON.stringify(before)===JSON.stringify(snapshot(directory)));
    if(!latest)return empty(false);
    if(latest.type===0)return empty(true,latest.sequence.toString());
    const {value}=latest;requireValid(value.length>0&&(value[0]===1||value[0]===0));
    requireValid(value[0]!==0||(value.length-1)%2===0);
    const {state}=JSON.parse(value.subarray(1).toString(value[0]===1?'latin1':'utf16le'));
    requireValid(state&&[state.unreadIds,state.explicitUnreadIds].every(ids=>
      Array.isArray(ids)&&ids.every(id=>typeof id==='string')));
    return {known:true,unreadIds:new Set(state.unreadIds),explicitUnreadIds:new Set(state.explicitUnreadIds),...(withRevision?{revision:latest.sequence.toString()}:{})};
  }catch{return empty(false);}
}
