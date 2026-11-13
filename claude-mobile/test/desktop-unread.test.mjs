import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,statSync,rmSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readDesktopUnread} from '../backend/lib/desktop-unread.mjs';

const KEY=Buffer.from('_app://localhost\0\x01epitaxy-unread-v1');
const cat=parts=>Buffer.concat(parts.map(part=>Buffer.isBuffer(part)?part:Buffer.from(part)));
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const varint=n=>{const b=[];do{b.push((n%128)|(n>=128?128:0));n=Math.floor(n/128);}while(n);return Buffer.from(b);};
const str=b=>cat([varint(b.length),b]);
// Deliberately independent, bit-at-a-time CRC32C fixture writer.
function crc(bytes,masked=true){
  let n=0xffffffff;
  for(const byte of bytes){n^=byte;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0x82f63b78:0);}
  n=(~n)>>>0;return masked?(((n>>>15)|(n<<17))+0xa282ead8)>>>0:n;
}
function value(unreadIds=['local_desktop'],explicitUnreadIds=[],encoding=1){
  return cat([[encoding],Buffer.from(JSON.stringify({state:{unreadIds,explicitUnreadIds,stoppedRuns:[]},version:0}),encoding?'latin1':'utf16le')]);
}
const put=(data=value(),key=KEY)=>({key,type:1,data});
const del=()=>({key:KEY,type:0,data:Buffer.alloc(0)});
function batch(sequence,rows){
  return cat([u64(sequence),u32(rows.length),...rows.map(r=>cat([[r.type],str(r.key),...(r.type?[str(r.data)]:[])]))]);
}
function physical(type,data){
  const header=Buffer.alloc(7);header.writeUInt32LE(crc(cat([[type],data])));
  header.writeUInt16LE(data.length,4);header[6]=type;return cat([header,data]);
}
function wal(records){
  const parts=[];let position=0;
  for(const record of records){
    let p=0,first=true;
    do{
      const left=32768-position%32768;
      if(left<7){parts.push(Buffer.alloc(left));position+=left;continue;}
      const n=Math.min(record.length-p,left-7),last=p+n===record.length;
      const piece=physical(first?(last?1:2):(last?4:3),record.subarray(p,p+n));
      parts.push(piece);position+=piece.length;p+=n;first=false;
    }while(p<record.length);
  }
  return cat(parts);
}
function block(rows){
  const parts=[],restarts=[0];let previous=Buffer.alloc(0),offset=0,i=0;
  for(const [key,data] of rows){
    if(i>0&&i%2===0){restarts.push(offset);previous=Buffer.alloc(0);}i++;
    let shared=0;while(shared<Math.min(key.length,previous.length)&&key[shared]===previous[shared])shared++;
    const entry=cat([varint(shared),varint(key.length-shared),varint(data.length),key.subarray(shared),data]);
    parts.push(entry);offset+=entry.length;previous=key;
  }
  return cat([...parts,...restarts.map(u32),u32(restarts.length)]);
}
// Small test compressor emits literal and overlapping backreferences of all
// three widths, including the high offset bits of COPY_1 when available.
function compress(bytes,type=1,literalWidth=0){
  const parts=[varint(bytes.length)];let p=0,start=0,copies=0;
  function literal(end){
    const n=end-start;if(!n)return;
    if(n<=60&&!literalWidth)parts.push(Buffer.from([(n-1)<<2]));
    else{
      const width=literalWidth||Math.ceil(Math.log2(n)/8)||1,b=Buffer.alloc(width);
      b.writeUIntLE(n-1,0,width);parts.push(cat([[(59+width)<<2],b]));
    }
    parts.push(bytes.subarray(start,end));
  }
  while(p+4<=bytes.length){
    const previous=bytes.lastIndexOf(bytes.subarray(p,p+4),p-1);
    const offset=p-previous,max=type===1?11:64;
    if(p===0||previous<0||offset>(type===1?2047:65535)){p++;continue;}
    let n=4;while(n<max&&p+n<bytes.length&&bytes[p+n]===bytes[p+n-offset])n++;
    literal(p);
    if(type===1)parts.push(Buffer.from([1|((n-4)<<2)|((offset>>>8)<<5),offset&255]));
    else{const b=Buffer.alloc(type===2?2:4);b.writeUIntLE(offset,0,b.length);parts.push(cat([[type|((n-1)<<2)],b]));}
    p+=n;start=p;copies++;
  }
  literal(bytes.length);return {bytes:cat(parts),copies};
}
function sst(rows,{compression=0,copyType=1,literalWidth=0}={}){
  const parts=[];let offset=0;
  function append(data){
    const raw=compression?compress(data,copyType,literalWidth).bytes:data;
    const stored=cat([raw,[compression]]),handle=cat([varint(offset),varint(raw.length)]);
    parts.push(cat([stored,u32(crc(stored))]));offset+=stored.length+4;return handle;
  }
  const internal=rows.map(r=>[cat([r.key,u64((BigInt(r.sequence)<<8n)|BigInt(r.type))]),r.data]);
  // Multiple data blocks, each with shared-prefix entries, and an index block.
  const index=[];
  for(let p=0;p<internal.length;p+=2){const chunk=internal.slice(p,p+2);index.push([chunk.at(-1)[0],append(block(chunk))]);}
  const meta=append(block([])),idx=append(block(index)),footer=Buffer.alloc(48);
  cat([meta,idx]).copy(footer);footer.writeBigUInt64LE(0xdb4775248b80fb57n,40);
  return cat([...parts,footer]);
}
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'desktop-unread-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return {directory,write:(name,bytes)=>writeFileSync(join(directory,name),bytes),read:()=>readDesktopUnread({directory})};
}
const expected=(ids=[],explicit=[],known=true)=>({known,unreadIds:new Set(ids),explicitUnreadIds:new Set(explicit)});
const unknown=()=>expected([],[],false);

test('CRC fixture agrees with the published CRC32C check vector',()=>assert.equal(crc(Buffer.from('123456789'),false),0xe3069283));

test('selects sequence, including WriteBatch operation offsets, rather than filename or mtime',t=>{
  const f=fixture(t);
  f.write('999999.log',wal([batch(10,[put(value(['local_old']))])]));
  f.write('000001.log',wal([batch(8,[put(value(['local_older']))]),batch(9,[put(value(['local_a'])),put(value(['local_b'])),put(value(['local_new'],['local_manual']))])]));
  assert.deepEqual(f.read(),expected(['local_new'],['local_manual']));
});

test('reassembles FIRST/MIDDLE/LAST across 32KiB boundaries and zero trailers',t=>{
  const f=fixture(t),id='local_'+ 'x'.repeat(100000);
  for(const length of [32730,32726]){
    const unrelated=put(Buffer.alloc(length,65),Buffer.from('private-key'));
    f.write('000001.log',wal([batch(1,[unrelated]),batch(2,[put(value([id]))])]));
    assert.deepEqual(f.read(),expected([id]));
  }
});

test('SST prefix entries and raw Snappy literal/COPY_1/COPY_2/COPY_4 blocks',t=>{
  const f=fixture(t),id='local_'+ 'abc'.repeat(150);
  for(const compression of [0,1])for(const copyType of [1,2,3])for(const literalWidth of [0,1,2,3,4]){
    const rows=[{...put(value([id])),sequence:92},{...put(value(['local_old'])),sequence:91},
      ...['other-a','other-b','other-c'].map(key=>({...put(Buffer.from('not-json'),Buffer.from(key)),sequence:500}))];
    assert.ok(compress(block(rows.slice(0,2).map(r=>[r.key,r.data])),copyType,literalWidth).copies>0);
    f.write('000001.ldb',sst(rows,{compression,copyType,literalWidth}));
    assert.deepEqual(f.read(),expected([id]));
  }
});

test('latest sequence wins across SST and WAL; both forms of tombstone are known-empty',t=>{
  const f=fixture(t);
  f.write('999999.ldb',sst([{...put(value(['local_sst'])),sequence:100}],{compression:1}));
  f.write('000001.log',wal([batch(99,[put(value(['local_wal']))])]));
  assert.deepEqual(f.read(),expected(['local_sst']));
  f.write('000001.log',wal([batch(101,[del()])]));assert.deepEqual(f.read(),expected());
  f.write('000002.sst',sst([{...del(),sequence:102}]));assert.deepEqual(f.read(),expected());
  f.write('000001.log',wal([batch(103,[put(value(['local_returned']))])]));
  assert.deepEqual(f.read(),expected(['local_returned']));
});

test('Chromium UTF16 and empty persisted arrays; returned sets never alias later calls',t=>{
  const f=fixture(t);f.write('1.log',wal([batch(1,[put(value(['local_中文'],[],0))])]));
  assert.deepEqual(f.read(),expected(['local_中文']));
  f.write('1.log',wal([batch(2,[put(value([]))])]));const first=f.read();first.unreadIds.add('fake');
  assert.deepEqual(f.read(),expected());
});

test('missing directory/key and malformed latest value are unknown, with no fallback',t=>{
  const f=fixture(t);assert.deepEqual(readDesktopUnread({directory:join(f.directory,'missing')}),unknown());
  assert.deepEqual(f.read(),unknown());
  f.write('1.log',wal([batch(1,[put(value(['cli_should_not_leak']),Buffer.from('other-key'))])]));
  assert.deepEqual(f.read(),unknown());
  f.write('1.log',wal([batch(1,[put()]),batch(2,[put(Buffer.from('\x01not-json'))])]));
  assert.deepEqual(f.read(),unknown());
  for(const data of [Buffer.from('{}'),Buffer.from('\x01{}'),Buffer.from('\x01{"state":{"unreadIds":[1],"explicitUnreadIds":[]}}')]){
    f.write('1.log',wal([batch(3,[put(data)])]));assert.deepEqual(f.read(),unknown());
  }
});

test('every truncated WAL/SST prefix fails closed; bad checksum cannot resurrect an older record',t=>{
  const f=fixture(t);f.write('0.log',wal([batch(1,[put(value(['local_stale']))])]));
  for(const [name,bytes] of [['1.log',wal([batch(2,[put()])])],['1.ldb',sst([{...put(),sequence:2}],{compression:1})]]){
    // An empty WAL is legitimate; all nonempty incomplete records are unknown.
    for(let n=1;n<bytes.length;n++){f.write(name,bytes.subarray(0,n));assert.deepEqual(f.read(),unknown(),`${name} prefix ${n}`);}
    const damaged=Buffer.from(bytes);damaged[8]^=1;f.write(name,damaged);assert.deepEqual(f.read(),unknown());
    rmSync(join(f.directory,name));
  }
});

test('rejects invalid fragment ordering, batch bounds, conflicting sequences and SST handles',t=>{
  const f=fixture(t);
  for(const bytes of [physical(3,batch(1,[put()])),physical(2,batch(1,[put()])),
    physical(1,cat([u64(1),u32(1),[1,255,255,255,255,127]])),
    wal([batch(1,[put()]),batch(1,[del()])]),physical(1,batch(1n<<56n,[put()])),
    cat([wal([batch(1,[put()])]),[0,0,0]])]){
    f.write('1.log',bytes);assert.deepEqual(f.read(),unknown());
  }
  rmSync(join(f.directory,'1.log'));
  const bad=sst([{...put(),sequence:1}]);bad.fill(255,bad.length-48,bad.length-8);
  f.write('1.ldb',bad);assert.deepEqual(f.read(),unknown());
});

test('malformed Snappy offsets, lengths and prefix/restart bounds fail without leaking values',t=>{
  const f=fixture(t);
  function rawTable(raw,type=1){
    const stored=cat([raw,[type]]),data=cat([stored,u32(crc(stored))]);
    const index=block([[KEY,cat([varint(0),varint(raw.length)])]]),idx=cat([index,[0]]);
    const footer=Buffer.alloc(48);cat([[0,0],varint(data.length),varint(index.length)]).copy(footer);
    footer.writeBigUInt64LE(0xdb4775248b80fb57n,40);return cat([data,idx,u32(crc(idx)),footer]);
  }
  for(const raw of [cat([varint(8),[1,0]]),cat([varint(8),[2,1,0]]),
    cat([varint(0xffffffff),[0,65]]),cat([varint(1),[0,65,0,66]]),
    cat([varint(8),[240]]),cat([varint(8),[12,65,66]])]){
    f.write('1.ldb',rawTable(raw));assert.deepEqual(f.read(),unknown());
  }
  for(const raw of [cat([[1,0,0],u32(0),u32(1)]),cat([[0,0,0],u32(99),u32(1)]),cat([u32(0xffffffff)])]){
    f.write('1.ldb',rawTable(raw,0));assert.deepEqual(f.read(),unknown());
  }
});

test('refreshes same-size file changes and preserves all database bytes/metadata, including LOCK',t=>{
  const f=fixture(t);f.write('1.log',wal([batch(1,[put(value(['local_a']))])]));
  f.write('LOCK',Buffer.from('do-not-touch'));f.write('CURRENT',Buffer.from('MANIFEST-000001\n'));
  const snap=()=>readdirSync(f.directory).sort().map(name=>{
    const s=statSync(join(f.directory,name),{bigint:true});
    return [name,readFileSync(join(f.directory,name)).toString('hex'),String(s.size),String(s.mtimeNs),String(s.ctimeNs)];
  });
  const before=snap();assert.deepEqual(f.read(),expected(['local_a']));assert.deepEqual(snap(),before);
  f.write('1.log',wal([batch(2,[put(value(['local_b']))])]));
  utimesSync(join(f.directory,'1.log'),new Date(),new Date(Date.now()+1000));
  assert.deepEqual(f.read(),expected(['local_b']));
});
