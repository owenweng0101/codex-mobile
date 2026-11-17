import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';

// Inspect the reviewed local bundle, never execute it or download replacement
// assets. A fake per-task listener previously concealed the empty-history bug.
test('reviewed native transport listens by workspace and subscribes by session',async t=>{
 let source;
 try{source=await readFile(new URL('../frontend-stage/assets/index-BsmXQHMM.js',import.meta.url),'utf8');}
 catch(error){if(error.code==='ENOENT'){t.skip('reviewed local Codex compatibility bundle is not present');return;}throw error;}
 const ast=parse(source,{sourceType:'module'}),listeners=[],subscriptions=[];
 const propertyNames=node=>node?.type==='ObjectExpression'?node.properties.filter(value=>value.type==='ObjectProperty').map(value=>value.key.name||value.key.value):[];
 traverseModule.default(ast,{CallExpression(path){
  const callee=path.node.callee;if(callee.type!=='MemberExpression')return;
  if(callee.property.name==='onDynamicConversationFrame'){
   const argument=path.node.arguments[0],binding=argument.type==='Identifier'?path.scope.getBinding(argument.name)?.path.node.init:argument;
   listeners.push(propertyNames(binding));
  }
  if(callee.property.name==='subscribeConversationV4')subscriptions.push(propertyNames(path.node.arguments[0]));
 }});
 assert.ok(listeners.length>0);assert.ok(subscriptions.length>0);
 for(const names of listeners){assert.ok(names.includes('workspacePath'));assert.ok(!names.includes('sessionId'),'frame event is shared by all sessions in that workspace');}
 for(const names of subscriptions)assert.ok(names.includes('sessionId'),'subscription ACK still belongs to the selected session');
});
