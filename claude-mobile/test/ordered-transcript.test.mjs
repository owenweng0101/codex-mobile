import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseTranscript} from '../backend/lib/sessions.mjs';

const assistantSource=readFileSync(new URL('../backend/lib/assistant-view.js',import.meta.url),'utf8');
const uiSource=readFileSync(new URL('../backend/lib/ui.mjs',import.meta.url),'utf8');
// Execute the actual history consumer, rather than recreating its block dispatch.
const consumerStart=uiSource.indexOf('  let historyAssistant = null;');
const consumerEnd=uiSource.indexOf('  function stopPoll(){',consumerStart);
assert.ok(consumerStart>=0&&consumerEnd>consumerStart,'history consumer must be present');
const consumerSource=uiSource.slice(consumerStart,consumerEnd);

// Only tree/class operations used by assistant-view; no browser, HTML parser,
// layout, filesystem fixtures, network, real timers or implementation changes.
function harness(){
  class Node {
    constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.className='';this.value='';}
    get textContent(){return this.value+this.children.map(child=>child.textContent).join('');}
    set textContent(value){for(const child of this.children)child.parentNode=null;this.children=[];this.value=String(value);}
    get classList(){
      const tokens=()=>this.className.split(/\s+/).filter(Boolean);
      return {
        contains:name=>tokens().includes(name),
        add:(...names)=>{this.className=[...new Set([...tokens(),...names])].join(' ');},
        remove:(...names)=>{this.className=tokens().filter(name=>!names.includes(name)).join(' ');},
        toggle:(name,force)=>{const present=force===undefined?!tokens().includes(name):Boolean(force);if(present)this.classList.add(name);else this.classList.remove(name);return present;}
      };
    }
    append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
    remove(){if(!this.parentNode)return;const parent=this.parentNode;parent.children.splice(parent.children.indexOf(this),1);this.parentNode=null;}
    matches(selector){const match=/^([\w-]+)?(?:\.([\w-]+))?$/.exec(selector);return !!match&&(!match[1]||this.tagName===match[1].toUpperCase())&&(!match[2]||this.classList.contains(match[2]));}
    querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  }
  const container=new Node('main'),renders=[],owners=[];
  const renderText=(node,text)=>{renders.push({node,text});node.textContent=text;};
  const window={claudeToolName:name=>name};
  const context=vm.createContext({window,document:{createElement:tag=>new Node(tag)}});
  vm.runInContext(assistantSource,context,{filename:'assistant-view.js'});
  const create=()=>{const owner=window.createClaudeAssistant({container,renderText});owners.push(owner);return owner;};
  context.newAssistant=create;
  context.addUserMessage=text=>{const node=new Node('div');node.className='msg user';node.textContent=text;container.append(node);};
  vm.runInContext(consumerSource,context,{filename:'ui.mjs:appendMessage'});
  return {container,renders,owners,create,append:message=>context.appendMessage(message)};
}

const text=value=>({type:'text',text:value});
const thinking=value=>({type:'thinking',thinking:value});
const tool=(id='read',name='Read')=>({type:'tool_use',id,name,input:{file_path:'/tmp/example'}});
const timestamp=second=>new Date(Date.UTC(2026,10,13,0,0,second)).toISOString();
const assistant=(id,content,stop_reason=null,second=1)=>({uuid:id,type:'assistant',timestamp:timestamp(second),message:{content,stop_reason}});
const result=(id,value,isError=false,second=2)=>({uuid:'result-'+second,type:'user',timestamp:timestamp(second),message:{content:[{type:'tool_result',tool_use_id:id,content:value,is_error:isError}]}});
const parse=(records,since=0)=>parseTranscript(records.map(record=>typeof record==='string'?record:JSON.stringify(record)).join('\n'),'session',since);
const kinds=owner=>owner.wrap.children.map(node=>node.className);
const processKinds=owner=>owner.wrap.querySelector('.process-content').children.map(node=>node.className);
const summary=owner=>owner.wrap.querySelector('.activity').querySelector('summary').textContent;
const assertSettled=owner=>{
  assert.equal(owner.wrap.querySelectorAll('.pending').length,0,'terminal must clear every tool spinner');
  assert.equal(owner.wrap.querySelectorAll('.spark').length,0,'terminal must clear thinking spinners');
  assert.doesNotMatch(summary(owner),/正在思考|执行中/);
};

test('view preserves text → tools → thinking → tools → text in DOM order',()=>{
  const h=harness(),owner=h.create();
  owner.appendText('先说明','a');owner.addTool('one','Read','first');
  owner.appendThinking('检查结果','b');owner.addTool('two','Bash','second');
  owner.appendText('最后回答','c');
  assert.deepEqual(kinds(owner),['bubble','activity','bubble']);
  assert.deepEqual(processKinds(owner),['tools','think','tools']);
  assert.deepEqual(owner.wrap.querySelectorAll('.bubble').map(node=>node.textContent),['先说明','最后回答']);
  assert.equal(owner.wrap.querySelector('.body').textContent,'检查结果');
  assert.equal(owner.text,'先说明\n\n最后回答');
  assert.equal(owner.wrap.querySelectorAll('.activity').length,1);
});

test('view starts a separate process after intervening text',()=>{
  const owner=harness().create();
  owner.appendThinking('第一段');owner.appendText('中间');owner.addTool('read','Read');owner.appendText('结尾');
  assert.deepEqual(kinds(owner),['activity','bubble','activity','bubble']);
  assert.equal(owner.wrap.querySelectorAll('.activity').length,2);
});

test('text chunks within one record preserve Markdown syntax without invented separators',()=>{
  const h=harness(),owner=h.create();
  for(const chunk of ['**加','粗**\n\n```js\n','const x = 1;','\n```'])owner.appendText(chunk,'same-message');
  assert.equal(owner.wrap.querySelectorAll('.bubble').length,1);
  assert.equal(h.renders.at(-1).text,'**加粗**\n\n```js\nconst x = 1;\n```');
  assert.equal(owner.text,h.renders.at(-1).text);
});

test('record boundaries insert one paragraph separator but repeated chunks do not',()=>{
  const h=harness(),owner=h.create();
  owner.appendText('第一','a');owner.appendText('段','a');
  owner.appendText('第二','b');owner.appendText('段','b');
  assert.equal(h.renders.at(-1).text,'第一段\n\n第二段');
  assert.equal(owner.text,'第一段\n\n第二段');
  assert.equal(owner.wrap.querySelectorAll('.bubble').length,1);
});

test('thinking record boundaries preserve paragraphs independently of text boundaries',()=>{
  const owner=harness().create();
  owner.appendThinking('第一','a');owner.appendThinking('段','a');owner.appendThinking('第二段','b');
  assert.equal(owner.wrap.querySelector('.body').textContent,'第一段\n\n第二段');
  owner.appendText('回答','b');
  assert.equal(owner.text,'回答');assert.equal(owner.wrap.querySelectorAll('.spark').length,0);
});

test('a new thinking record after thinkDone resumes visible thinking state',()=>{
  const owner=harness().create();
  owner.appendThinking('第一段','a');owner.thinkDone();owner.appendThinking('第二段','b');
  assert.match(summary(owner),/正在思考/);
  assert.ok(owner.wrap.querySelector('.spark'),'resumed thinking needs its progress indicator');
  assert.match(owner.wrap.querySelector('.think-label').textContent,/正在思考/);
});

test('duplicate tool ids reuse their original row across text/process boundaries',()=>{
  const owner=harness().create(),first=owner.addTool('same','Read','original');
  owner.appendText('中间','a');
  assert.equal(owner.addTool('same','Read','duplicate'),first);
  owner.addTool('other','Bash','next');owner.addTool('same','Read','again');
  assert.equal(owner.wrap.querySelectorAll('.tool').length,2);
  assert.equal(owner.toolMap.size,2);
  assert.deepEqual(kinds(owner),['activity','bubble','activity']);
  owner.toolResult('same','result');
  assert.equal(first.querySelector('pre').textContent,'result');
  assert.equal(owner.wrap.querySelectorAll('pre').length,1);
});

for(const status of ['complete','failed','interrupted']){
  test(`terminal ${status}: missing result becomes unconfirmed, never successful or spinning`,()=>{
    const owner=harness().create();owner.addTool('missing','Read');owner.appendThinking('尚在思考');
    owner.finish(status);owner.finish(status);
    assertSettled(owner);
    const row=owner.wrap.querySelector('.tool');
    assert.ok(row.classList.contains('unconfirmed'));
    assert.equal(row.querySelector('pre'),null,'do not fabricate output');
    assert.match(summary(owner),/状态待同步/);assert.doesNotMatch(summary(owner),/已完成/);
  });

  for(const isError of [false,true]){
    test(`late ${isError?'error':'success'} after ${status} resolves the same unconfirmed row`,()=>{
      const owner=harness().create();const row=owner.addTool('late','Read');
      owner.finish(status);owner.toolResult('late','迟到结果',isError);
      assertSettled(owner);
      assert.equal(owner.wrap.querySelector('.tool'),row);
      assert.equal(row.classList.contains('unconfirmed'),false);
      assert.equal(row.classList.contains('failed'),isError);
      assert.equal(row.querySelector('pre').textContent,'迟到结果');
      assert.doesNotMatch(summary(owner),/状态待同步/);
      assert.match(summary(owner),isError?/部分失败/:status==='complete'?/已完成/:/本轮已中断/);
    });
  }
}

test('late results settle only their own tool and repeated results replace output',()=>{
  const owner=harness().create();owner.addTool('one','Read');owner.addTool('two','Read');owner.finish();
  owner.toolResult('one','failed',true);assert.match(summary(owner),/状态待同步/);
  owner.toolResult('one','recovered',false);owner.toolResult('two','');owner.toolResult('absent','ignore');
  assertSettled(owner);assert.match(summary(owner),/已完成 · 2 项操作/);
  assert.equal(owner.wrap.querySelectorAll('pre').length,2);
  assert.deepEqual(owner.wrap.querySelectorAll('pre').map(node=>node.textContent),['recovered','（无输出）']);
  assert.equal(owner.wrap.querySelectorAll('.failed').length,0);
});

test('parseTranscript preserves every ordered block and untrimmed boundary text',()=>{
  const value=parse([assistant('a',[text('  前言\n'),tool(),thinking(' 分析 '),text('\n结尾  ')],'end_turn')]);
  const message=value.messages[0];
  assert.deepEqual(message.blocks,[{type:'text',text:'  前言\n'},{type:'tool',id:'read'},{type:'thinking',text:' 分析 '},{type:'text',text:'\n结尾  '}]);
  assert.equal(message.terminal,true);
  assert.equal(message.tools[0].detail,'/tmp/example');
  assert.equal(message.tools[0].result,null);
});

test('parseTranscript keeps adjacent text and thinking blocks as separate ordered entries',()=>{
  const message=parse([assistant('a',[text('A'),text('B'),thinking('C'),thinking('D'),text('E')])]).messages[0];
  assert.deepEqual(message.blocks,[{type:'text',text:'A'},{type:'text',text:'B'},{type:'thinking',text:'C'},{type:'thinking',text:'D'},{type:'text',text:'E'}]);
});

test('parseTranscript supports string content and ignores sidechains and invalid JSON',()=>{
  const value=parse(['{bad json',assistant('a','  回答  ','end_turn'),{...assistant('side',[text('支线')]),isSidechain:true}]);
  assert.equal(value.messages.length,1);
  assert.deepEqual(value.messages[0].blocks,[{type:'text',text:'  回答  '}]);
  assert.equal(value.messages[0].terminal,true);
});

for(const stop_reason of ['end_turn','tool_use',null,undefined]){
  test(`parseTranscript stop_reason=${String(stop_reason)} marks only end_turn terminal`,()=>{
    const record=assistant('a',[text('回答')],stop_reason);
    if(stop_reason===undefined)delete record.message.stop_reason;
    const message=parse([record]).messages[0];
    assert.equal(message.terminal,stop_reason==='end_turn');
  });
}

test('history consumer replays parsed blocks in order, deduplicates tool ids and seen messages',()=>{
  const records=[assistant('a',[text('先说'),tool('same'),thinking('再想'),text('后说')],'tool_use'),
    assistant('b',[tool('same'),text('完成')],'end_turn',2),result('same','结果',false,3)];
  const value=parse(records),h=harness();for(const message of value.messages)h.append(message);
  for(const message of value.messages)h.append(message);
  assert.equal(h.owners.length,1);const owner=h.owners[0];
  assert.deepEqual(kinds(owner),['bubble','activity','bubble']);
  assert.deepEqual(processKinds(owner),['tools','think']);
  assert.deepEqual(owner.wrap.querySelectorAll('.bubble').map(node=>node.textContent),['先说','后说\n\n完成']);
  assert.equal(owner.wrap.querySelectorAll('.tool').length,1);
  assert.equal(owner.wrap.querySelector('pre').textContent,'结果');assertSettled(owner);
});

test('history end_turn settles an unresolved tool from an earlier record',()=>{
  const h=harness(),value=parse([assistant('a',[tool()],'tool_use'),assistant('b',[text('结束')],'end_turn',2)]);
  for(const message of value.messages)h.append(message);
  assertSettled(h.owners[0]);assert.match(summary(h.owners[0]),/状态待同步/);
});

test('an empty end_turn must reach history consumer to settle an earlier unresolved tool',()=>{
  const h=harness(),value=parse([assistant('a',[tool()],'tool_use'),assistant('b',[],'end_turn',2)]);
  for(const message of value.messages)h.append(message);
  assertSettled(h.owners[0]);
  assert.ok(value.messages.some(message=>message.id==='b'&&message.terminal),'keep terminal-only record');
  assert.equal(h.owners[0].wrap.querySelectorAll('.unconfirmed').length,1);
});

test('incremental late result has no new assistant message and restores a terminal tool',()=>{
  const records=[assistant('a',[tool()],'end_turn')],h=harness();
  h.append(parse(records).messages[0]);const owner=h.owners[0];assertSettled(owner);
  const update=parse([...records,result('read',[{type:'text',text:'迟到'},{type:'text',text:'结果'}],false,3)],1);
  assert.deepEqual(update.messages,[]);
  assert.deepEqual(update.toolUpdates,[{id:'read',text:'迟到\n结果',isError:false,seq:2,ts:timestamp(3)}]);
  for(const item of update.toolUpdates)owner.toolResult(item.id,item.text,item.isError);
  assertSettled(owner);assert.match(summary(owner),/已完成/);
  assert.equal(owner.wrap.querySelector('pre').textContent,'迟到\n结果');
  assert.equal(owner.wrap.querySelectorAll('.unconfirmed').length,0);
});

test('full transcript backfills tool results without inserting them into assistant block order',()=>{
  const value=parse([assistant('a',[text('前'),tool(),text('后')],'end_turn'),result('read','failed',true)]);
  assert.equal(value.messages.length,1);
  assert.deepEqual(value.messages[0].blocks,[{type:'text',text:'前'},{type:'tool',id:'read'},{type:'text',text:'后'}]);
  assert.equal(value.messages[0].tools[0].result,'failed');assert.equal(value.messages[0].tools[0].isError,true);
  const h=harness();h.append(value.messages[0]);assertSettled(h.owners[0]);assert.match(summary(h.owners[0]),/部分失败/);
});
