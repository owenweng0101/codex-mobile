import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rolloutItem,workspaceGit } from '../core.mjs';
import { desktopHistory } from '../desktop-bridge.mjs';
import { displayTurn } from '../view.mjs';

// Synthetic fields follow installed experimental v2/ThreadItemsReadResponse
// ThreadItem.ImageGeneration: fileId OR result, optional savedPath; SDK camelCase.
// The snake_case variant is compatibility with the existing rollout adapters,
// not a claim that a business rollout or real image generation was inspected.
test('canonical SDK imageGeneration survives native history then scoped public view without private source fields',()=>{
 const generated={id:'image-one',type:'imageGeneration',status:'completed',fileId:'native-secret-file',savedPath:'/private/native-cache/picture.png',result:'',revisedPrompt:'not public'};
 const raw=desktopHistory({id:'thread-one',turns:[{turnId:'turn-one',status:'completed',params:{input:[]},items:[generated]}]});
 assert.equal(raw.turns[0].items[0],generated);
 const turn=displayTurn(raw.turns[0],{threadId:'thread-one'});assert.equal(turn.items[0].type,'imageGeneration');assert.deepEqual(turn.items[0].media.reference,{threadId:'thread-one',turnId:'turn-one',itemId:'image-one',index:0});
 const json=JSON.stringify(turn);assert.equal(json.includes('/private/'),false);assert.equal(json.includes('native-secret-file'),false);assert.equal(json.includes('not public'),false);assert.deepEqual(displayTurn(turn,{threadId:'thread-one'}),turn);
});

test('rollout image generation mapping accepts known camelCase and synthetic snake_case fields without exposing unrelated metadata',()=>{
 for(const raw of [
  {id:'image-one',type:'ImageGeneration',status:'completed',file_id:'native-secret-file',saved_path:'/private/native-cache/image.png',result:''},
  {id:'image-one',type:'imageGeneration',status:'completed',fileId:'native-secret-file',savedPath:'/private/native-cache/image.png',result:''},
 ]){
  const item=rolloutItem({...raw,unrelated:'private'});assert.equal(item.type,'imageGeneration');assert.equal(item.fileId,'native-secret-file');assert.equal(item.savedPath,'/private/native-cache/image.png');assert.equal(item.result,'');assert.equal(item.unrelated,undefined);
  const publicTurn=displayTurn({id:'turn-one',items:[item]},{threadId:'thread-one'});assert.match(publicTurn.items[0].media.url,/^\/api\/thread-media\?/);assert.equal(JSON.stringify(publicTurn).includes('/private/'),false);
 }
 const inline=rolloutItem({id:'image-two',type:'ImageGeneration',status:'completed',result:'iVBORw0KGgo='});assert.equal(inline.result,'iVBORw0KGgo=');
 const unsupported=rolloutItem({id:'unknown',type:'UnrecognizedPrivateItem',output:'private'});assert.equal(unsupported,null);
});

test('native recordedTurnDiff and imageGeneration coexist without replacing recorded file change or turn identity',()=>{
 const generated={id:'image-one',type:'imageGeneration',status:'completed',result:'iVBORw0KGgo='},file={id:'file-one',type:'fileChange',status:'completed',changes:[{path:'/workspace/example.txt',kind:{type:'update',movePath:'/workspace/renamed.txt'},diff:'@@ -1 +1 @@\n-before\n+after'}]};
 const history=desktopHistory({id:'thread-one',turns:[{turnId:'turn-one',status:'completed',params:{input:[]},items:[generated,file]}]});
 assert.equal(history.turnDiff.turnId,'turn-one');assert.equal(history.turnDiff.recordedChanges,true);assert.equal(history.turnDiff.fileChanges[0].id,'file-one');assert.equal(history.turnDiff.fileChanges[0].changes[0].kind.move_path,'/workspace/renamed.txt');assert.equal(history.turns[0].items.length,2);
});

test('current readWorkspaceGit module delegation remains imported intact without executing Git',async()=>{
 const source=await readFile(new URL('../core.mjs',import.meta.url),'utf8');assert.match(source,/import \{ readWorkspaceGit \} from '\.\/git-view\.mjs'/);assert.match(workspaceGit.toString(),/return readWorkspaceGit\(root, selectedPath, options\)/);
});
