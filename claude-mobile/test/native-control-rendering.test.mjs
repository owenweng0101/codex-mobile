import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTranscript} from '../backend/lib/sessions.mjs';
const origin={kind:'plugin',name:'mobile-native-bridge'};
const command='<command-name>/goal</command-name>\n<command-args>完成测试</command-args>';
const row=(uuid,text,extra={})=>({type:'user',uuid,message:{role:'user',content:text},...extra});
const lines=records=>records.map(r=>JSON.stringify(r)).join('\n')+'\n';
test('native goal command and generated startup note do not become user chat bubbles',()=>{
 const result=parseTranscript(lines([
  row('human','用户的问题',{origin:{kind:'human'}}),
  row('command',command,{origin}),
  row('note','A session-scoped Stop hook is now active with condition: 完成测试',{origin,isMeta:true}),
  {type:'assistant',uuid:'answer',message:{role:'assistant',content:'回答'}},
 ]),'session');
 assert.deepEqual(result.messages.map(m=>m.id),['human','answer']);
 assert.equal(result.currentUserId,'human');
});
test('literal user text that resembles a goal control is still shown',()=>{
 for(const source of [{kind:'human'},{...origin,asUser:true}]){
  const result=parseTranscript(lines([row('u',command,{origin:source})]),'session');
  assert.equal(result.messages.length,1);assert.equal(result.messages[0].text,command);
 }
});
test('another plugin message is not hidden by the mobile goal-control filter',()=>{
 const result=parseTranscript(lines([row('other','插件状态说明',{origin:{kind:'plugin',name:'other-plugin'},isMeta:true})]),'session');
 assert.equal(result.messages.length,1);
});
