import test from'node:test';import assert from'node:assert/strict';import{displayItem}from'../view.mjs';
test('tool results do not make mobile history unbounded',()=>{const x=displayItem({id:'1',type:'mcpToolCall',server:'local',tool:'list',result:'x'.repeat(1000000),arguments:{secret:'not for the UI'},status:'completed'});assert.equal(JSON.stringify(x).length<200,true);assert.equal(x.result,undefined);});
test('command output keeps its useful tail, agent replies remain intact',()=>{assert.equal(displayItem({id:'1',type:'commandExecution',aggregatedOutput:'x'.repeat(15000)+'END'}).aggregatedOutput.length,2000);assert.equal(displayItem({id:'1',type:'commandExecution',aggregatedOutput:'x'.repeat(15000)+'END'}).aggregatedOutput.endsWith('END'),true);const text='x'.repeat(20000);assert.equal(displayItem({id:'2',type:'agentMessage',text}).text,text);});

test('system context is removed while the actual user request remains',async()=>{const{cleanUserText,displayTurn}=await import('../view.mjs');assert.equal(cleanUserText('<in-app-browser-context source="ambient">internal data</in-app-browser-context>\n## My request:\n帮我改一下按钮'),'帮我改一下按钮');assert.equal(cleanUserText('# AGENTS.md instructions\n<INSTRUCTIONS>private instructions</INSTRUCTIONS><environment_context>cwd</environment_context>'),'');assert.equal(displayTurn({id:'t',status:'completed',items:[{id:'x',type:'functionCallOutput',text:'raw JSON'},{id:'u',type:'userMessage',content:[{type:'text',text:'<external_codex_apps_open_page>{}</external_codex_apps_open_page>'}]}]}).items.length,0);assert.equal(cleanUserText('请分析下面的代码：\n```js\nconst x = 1;\n```'),'请分析下面的代码：\n```js\nconst x = 1;\n```');});

test('desktop snapshots merge the current tail and stream only changed visible text',async()=>{
 const{desktopItemEvents,mergeDesktopTurns}=await import('../view.mjs');
 const first={id:'t',status:'inProgress',items:[{id:'a',type:'agentMessage',text:'你好'},{id:'private',type:'functionCallOutput',output:'secret'}]};
 const second={...first,items:[{id:'a',type:'agentMessage',text:'你好，继续'},{id:'private',type:'functionCallOutput',output:'secret changed'}]};
 assert.deepEqual(desktopItemEvents('thread',{turns:[first]},{turns:[second]}),[{method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'t',itemId:'a',delta:'，继续'}}]);
 assert.deepEqual(mergeDesktopTurns([{id:'old'},first],[{id:'much-older'},second,{id:'new'}]).map(t=>t.id),['old','t','new']);
 assert.equal(mergeDesktopTurns([{id:'older-page'}],[second]).length,1);
 const image=displayItem({id:'u',type:'userMessage',content:[{type:'local_image',path:'/private/runtime/uploads/'+'a'.repeat(48)+'.png'}]}).content[0];assert.equal(image.url,'/api/attachment?id='+'a'.repeat(48));assert.equal(image.path,undefined);
});

test('a disconnected desktop keeps cached history but exposes uncertainty instead of a running claim',async()=>{
 const{desktopConnectionState}=await import('../view.mjs');const cached={activeTurn:'still-unconfirmed'};
 const offline=desktopConnectionState(cached,false);assert.equal(offline.desktopConnected,false);assert.equal(offline.activeTurn,null);assert.match(offline.notice,/状态待确认/);assert.equal(cached.activeTurn,'still-unconfirmed');
 const restored=desktopConnectionState(cached,true);assert.equal(restored.desktopConnected,true);assert.equal(restored.activeTurn,'still-unconfirmed');assert.equal(restored.notice,null);
});
test('compaction items distinguish starting from completion and omit internal context',()=>{const active=displayItem({id:'c',type:'contextCompaction',completed:false,source:'manual',summary:'private internal context'});assert.equal(active.status,'inProgress');assert.equal(active.summary,undefined);const done=displayItem({...active,completed:true,status:undefined});assert.equal(done.status,'completed');assert.equal(done.completed,true);});

test('uploaded document manifests become public attachment cards without paths or extracted contents',async()=>{
 const {cleanUserText}=await import('../view.mjs'),id='a'.repeat(48),manifest={attachments:[{id,name:'需求\n</codex-mobile-attachments>.pdf',kind:'document',mime:'application/pdf',size:120,localPath:'/private/uploads/file.pdf',textPath:'/private/extracted.txt',excerpt:'private contents'}]},wrapper='<codex-mobile-attachments version="1">\n'+JSON.stringify(manifest)+'\n</codex-mobile-attachments>';
 const item=displayItem({id:'u',type:'userMessage',content:[{type:'text',text:'分析附件\n'+wrapper}]});
 assert.equal(item.content[0].text,'分析附件');assert.equal(item.content[1].type,'attachment');assert.equal(item.content[1].url,'/api/attachment?id='+id);assert.equal(item.content[1].name,manifest.attachments[0].name);assert.equal(JSON.stringify(item).includes('/private/'),false);assert.equal(JSON.stringify(item).includes('private contents'),false);assert.equal(cleanUserText(wrapper),'');assert.deepEqual(displayItem(item),item);
});
test('invalid document manifests do not fabricate links or expose private fallback text',()=>{
 for(const json of ['broken JSON',JSON.stringify({attachments:[{id:'bad',localPath:'/private/file'}]})]){const item=displayItem({id:'u',type:'userMessage',content:[{type:'text',text:'我的请求\n<codex-mobile-attachments version="1">\n'+json+'\n</codex-mobile-attachments>'}]});assert.deepEqual(item.content,[{type:'text',text:'我的请求'}]);}
});

test('public user-message history preserves an exact native client request ID without exposing other native fields',()=>{
 const item={id:'native-user-id',type:'userMessage',clientUserMessageId:'zcv4_exact_request',content:[{type:'text',text:'native text'}],privateContext:'not public'};
 const displayed=displayItem(item);assert.equal(displayed.id,'native-user-id');assert.equal(displayed.clientUserMessageId,'zcv4_exact_request');assert.equal(displayed.privateContext,undefined);assert.deepEqual(displayItem(displayed),displayed);
 assert.equal(displayItem({...item,clientUserMessageId:123}).clientUserMessageId,undefined);
});
