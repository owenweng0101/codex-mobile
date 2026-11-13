import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {desktopCatalog,listSessions} from '../backend/lib/sessions.mjs';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
test('desktop sidebar excludes archived and side sessions, deduplicates IDs, and never merges another profile',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mobile-catalog-'));
 try{
  const first=join(root,'first'),other=join(root,'other');await mkdir(first);await mkdir(other);
  const records=[{cliSessionId:id(1),sessionId:'app-1',title:'renamed',lastActivityAt:2},{cliSessionId:id(1),sessionId:'app-1',title:'old',lastActivityAt:1},{cliSessionId:id(2),sessionId:'archived',isArchived:true},{cliSessionId:id(3),sessionId:'side',spawnedFrom:{sideSession:true}},{cliSessionId:id(4),sessionId:'fork',spawnedFrom:{userFork:true}}];
  for(const [i,v] of records.entries())await writeFile(join(first,i+'.json'),JSON.stringify(v));
  await writeFile(join(other,'other.json'),JSON.stringify({sessionId:'other',cliSessionId:id(5)}));
  const result=await desktopCatalog({directories:[first,other]});assert.deepEqual(result.map(v=>v.cliSessionId).sort(),[id(1),id(4)]);assert.equal(result.find(v=>v.cliSessionId===id(1)).title,'renamed');
  assert.deepEqual(await desktopCatalog({directories:[join(root,'missing')]}),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('all desktop rows survive without transcripts; title, membership and order come from desktop metadata',async()=>{
 const catalog=async()=>Array.from({length:45},(_,i)=>({cliSessionId:id(i),sessionId:'app-'+i,title:'Desktop '+i,cwd:'/terminal',folderPlace:{cwd:'/desktop'},lastActivityAt:i+1}));
 const result=await listSessions({catalog,entries:async()=>[],running:async()=>new Map()});
 assert.equal(result.length,45);assert.equal(result[0].title,'Desktop 44');assert.equal(result[0].cwd,'/desktop');assert.equal(result.at(-1).id,id(0));assert.equal(result[0].messageCount,0);
});

test('unread membership uses desktop IDs and never treats an idle live owner as unread',async()=>{
 const catalog=async()=>[{cliSessionId:id(1),sessionId:'desktop-1',lastAssistantUuid:'reply-1'},{cliSessionId:id(2),sessionId:'desktop-2',lastAssistantUuid:'reply-2'}];
 const running=async()=>new Map([[id(1),{status:'idle'}]]);
 const unread=async()=>({known:true,unreadIds:new Set(['desktop-2']),explicitUnreadIds:new Set()});
 const result=await listSessions({catalog,entries:async()=>[],running,unread});
 assert.equal(result[0].running,true);assert.equal(result[0].unread,false);
 assert.equal(result[1].running,false);assert.equal(result[1].unread,true);
 assert.equal(result[1].unreadVersion,'reply-2:reply');
 const manual=await listSessions({catalog,entries:async()=>[],running,unread:async()=>({known:true,unreadIds:new Set(),explicitUnreadIds:new Set(['desktop-1'])})});
 assert.equal(manual[0].unread,true);assert.equal(manual[0].unreadVersion,'reply-1:manual');
});
