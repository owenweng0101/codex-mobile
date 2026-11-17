import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {chatHtml} from '../backend/lib/ui.mjs';
const html=chatHtml(),client=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('const deliveryCommands'));
function actualFunction(name){
  const start=client.indexOf('  function '+name+'('),lineEnd=client.indexOf('\n',start);
  assert.ok(start>=0,name);return client.slice(start,client.slice(start,lineEnd).endsWith('}')?lineEnd:client.indexOf('\n  }',lineEnd)+4);
}
function fixture(){
  const handlers=new Map(),submits=[],sent=[],drafts=new Map();let now=1000,updated=0;
  const input={value:'',scrollTop:0,style:new Proxy({},{set(){throw Error('input height must be owned by CSS');}}),addEventListener:(name,fn)=>handlers.set(name,fn)};
  Object.defineProperty(input,'scrollHeight',{get(){throw Error('content height must never resize the input');}});
  const state={attachments:[]};
  const api=runInNewContext('let draftKey=null;'+['syncInputHeight','afterComposerVisible','persistDrafts','saveDraft','restoreDraft'].map(actualFunction).join(String.fromCharCode(10))+'\n'+client.slice(client.indexOf("  input.addEventListener('input',"),client.indexOf('  bootstrap();'))+'\n({syncInputHeight,saveDraft,restoreDraft})',{
    input,state,drafts,draftStorage:'clm-drafts-v1',crypto:{randomUUID},sessionStorage:{setItem(){}},chatView:{classList:{contains:()=>false}},requestAnimationFrame:fn=>fn(),viewportChanged(){},renderAttachments(){},updateSendState(){updated++;},performance:{now:()=>now},send:value=>sent.push(value),composer:{addEventListener:(name,fn)=>submits.push(fn)},
  });
  return {api,input,state,drafts,sent,submits,handlers,updated:()=>updated,now:value=>now=value,key(extra={}){let prevented=false;handlers.get('keydown')({key:'Enter',preventDefault(){prevented=true;},...extra});return prevented;}};
}
test('typing and clearing never read scrollHeight or write an inline height',()=>{
  const h=fixture();h.input.value='很长的段落\n'.repeat(150);h.input.scrollTop=600;h.handlers.get('input')();assert.equal(h.input.scrollTop,600);assert.equal(h.updated(),1);
  h.input.value='';h.handlers.get('input')();assert.equal(h.input.scrollTop,0);
  assert.doesNotMatch(client,/input\.style\.height|input\.scrollHeight/);
});
test('restoring a multiline draft preserves text/attachments and resets inner scroll without resizing',()=>{
  const h=fixture(),attachment={id:'image-1'};h.drafts.set('long',{text:'多行草稿\n'.repeat(80),attachments:[attachment]});h.input.scrollTop=700;
  h.api.restoreDraft('long');assert.equal(h.input.value,h.drafts.get('long').text);assert.equal(h.state.attachments[0],attachment);assert.equal(h.input.scrollTop,0);
  h.api.restoreDraft('empty');assert.equal(h.input.value,'');assert.equal(h.state.attachments.length,0);
});
test('IME Enter/229/submit/commit guard and Shift+Enter retain their existing behavior',()=>{
  const h=fixture();h.input.value='输入法候选';h.handlers.get('compositionstart')();assert.equal(h.key(),false);h.submits[0]({preventDefault(){}});assert.equal(h.sent.length,0);
  h.handlers.get('compositionend')();assert.equal(h.key(),false);h.now(1100);
  assert.equal(h.key({isComposing:true}),false);assert.equal(h.key({keyCode:229}),false);assert.equal(h.key({shiftKey:true}),false);assert.equal(h.sent.length,0);
  assert.equal(h.key(),true);assert.deepEqual(h.sent,['输入法候选']);
  h.submits[0]({preventDefault(){}});assert.equal(h.sent.length,2);
});

test('393px/320px Ego: empty, long, multiline, keyboard viewport, draft, IME and attachment send',{skip:process.env.CLAUDE_COMPOSER_EGO!=='1',timeout:180000},async()=>{
  const posts=[],uploads=[];
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture'),json=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if(url.pathname==='/claude/api/sessions')return json({sessions:[]});
    if(url.pathname==='/claude/api/models')return json({models:[{model:'fixture-model',label:'Fixture model'}],defaultModel:'fixture-model',capabilities:{attachments:true}});
    if(url.pathname.startsWith('/claude/api/session/'))return json({id:'fixture-session',messages:[],cursor:0,control:{running:false}});
    if(url.pathname==='/stats')return json({posts,uploads});
    if(req.method==='POST'){
      let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
      if(url.pathname==='/claude/api/chat'){posts.push(body);return json({requestId:body.requestId,sessionId:'fixture-session',state:'accepted'});}
      if(url.pathname==='/claude/api/upload'){uploads.push(body.name);return json({id:'fixture-image',url:'/fixture.svg'});}
      return json({error:'unexpected write'});
    }
    if(url.pathname==='/fixture.svg'){res.writeHead(200,{'content-type':'image/svg+xml'});return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="gray"/></svg>');}
    res.writeHead(200,{'content-type':'text/html'});res.end(html);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const script=`
const task=await taskSpace('Claude fixed composer isolated verification');
console.log({spaceId:task.spaceId});
try{
  const page=task.page('p1');
  await page.cdp('Emulation.setDeviceMetricsOverride',{width:393,height:852,deviceScaleFactor:1,mobile:true});
  await page.goto('http://127.0.0.1:${server.address().port}/claude/');
  console.log(await page.snapshot());
  await page.click('#new');
  await page.waitForFunction(()=>!document.getElementById('composer').classList.contains('hidden')&&document.getElementById('modelLabel').textContent==='Fixture model');
  const installAssertions=()=>{
    window.composerErrors=[];addEventListener('unhandledrejection',event=>composerErrors.push(String(event.reason)));
    const input=document.getElementById('input');window.composerBaseline={height:input.getBoundingClientRect().height,form:document.getElementById('composer').getBoundingClientRect().height,box:input.parentElement.getBoundingClientRect().height};
    if(composerBaseline.height!==44||composerBaseline.form!==102)throw Error('fixed input or measured Codex composer height changed');
    window.assertComposer=(phase,overflow=false)=>{
      const input=document.getElementById('input'),form=document.getElementById('composer');
      const inputHeight=input.getBoundingClientRect().height,formHeight=form.getBoundingClientRect().height,boxHeight=input.parentElement.getBoundingClientRect().height;
      if(inputHeight!==composerBaseline.height||formHeight!==composerBaseline.form||boxHeight!==composerBaseline.box)throw Error(phase+': input/box/composer height changed');
      if(overflow){
        if(input.scrollHeight<=input.clientHeight)throw Error(phase+': long content cannot overflow');
        input.scrollTop=0;input.scrollTop=input.scrollHeight;
        if(input.scrollTop<=0||form.scrollTop!==0)throw Error(phase+': text must scroll inside textarea only');
      }
      return {phase,width:innerWidth,viewportHeight:innerHeight,inputHeight,boxHeight,formHeight,scrollHeight:input.scrollHeight,clientHeight:input.clientHeight,scrollTop:input.scrollTop};
    };
    return assertComposer('original-empty');
  };
  console.log(await page.evaluate(installAssertions));
  for(const size of [{width:393,height:852},{width:320,height:568},{width:393,height:400}]){
    await page.cdp('Emulation.setDeviceMetricsOverride',{...size,deviceScaleFactor:1,mobile:true});
    await page.waitForFunction(({width,height})=>innerWidth===width&&innerHeight===height,size);
    // Reload at each independent device size so focus/scroll from the preceding
    // emulated viewport cannot leave the fill target outside its new viewport.
    await page.reload();
    await page.waitForFunction(()=>!document.getElementById('composer').classList.contains('hidden')&&document.getElementById('modelLabel').textContent==='Fixture model');
    console.log(await page.evaluate(installAssertions));
    for(const [phase,value,overflow] of [
      ['empty','',false],
      ['long-wrapped-single-line','长内容'.repeat(1500),true],
      ['multiline',Array.from({length:120},(_,i)=>'第'+i+'行手机输入框内容').join(String.fromCharCode(10)),true],
      ['cleared','',false],
    ]){
      await page.fill('#input',value);
      console.log(await page.evaluate(({phase,overflow})=>window.assertComposer(phase,overflow),{phase,overflow}));
    }
  }
  await page.cdp('Emulation.setDeviceMetricsOverride',{width:393,height:852,deviceScaleFactor:1,mobile:true});
  await page.reload();
  await page.waitForFunction(()=>!document.getElementById('composer').classList.contains('hidden')&&document.getElementById('modelLabel').textContent==='Fixture model');
    console.log(await page.evaluate(installAssertions));
  await page.fill('#input',Array.from({length:120},(_,i)=>'第'+i+'行手机输入框内容').join(String.fromCharCode(10)));
  await page.click('#back');await page.click('#new');
  console.log(await page.evaluate(()=>{if(!document.getElementById('input').value.includes('119行'))throw Error('draft restore failed');return assertComposer('draft-restored',true);}));
  await page.fill('#input','中文候选确认');
  console.log(await page.evaluate(async()=>{
    const input=document.getElementById('input');input.dispatchEvent(new CompositionEvent('compositionstart',{data:'中文'}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));document.getElementById('composer').requestSubmit();
    const stats=await(await fetch('/stats')).json();if(stats.posts.length)throw Error('IME sent prematurely');input.dispatchEvent(new CompositionEvent('compositionend',{data:'中文候选确认'}));window.composerCommitAt=performance.now();return {imeDidNotSend:true};
  }));
  await page.waitForFunction(()=>performance.now()-window.composerCommitAt>100);
  await page.press('#input','Shift+Enter');
  await page.press('#input','Enter');
  await page.waitForFunction(()=>document.getElementById('input').value==='');
  console.log(await page.evaluate(async()=>{const stats=await(await fetch('/stats')).json();if(stats.posts.length!==1||stats.posts[0].text!=='中文候选确认')throw Error('send/Shift Enter regression');const input=document.getElementById('input');if(input.getBoundingClientRect().height!==44||input.scrollTop!==0)throw Error('send reset regression');return {sendAndImePassed:true,...assertComposer('send-cleared')};}));
  await page.evaluate(()=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([137,80,78,71])],'fixture.png',{type:'image/png'}));const file=document.getElementById('file');file.files=transfer.files;file.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForFunction(()=>document.querySelector('#attachments .thumb img')&&!document.querySelector('#attachments .up'));
  const attachmentFormHeight=await page.evaluate(()=>document.getElementById('composer').getBoundingClientRect().height);
  await page.fill('#input','附件长内容\\n'.repeat(50));
  console.log(await page.evaluate(height=>{const input=document.getElementById('input'),formHeight=document.getElementById('composer').getBoundingClientRect().height;if(input.getBoundingClientRect().height!==44||formHeight!==height||!document.querySelector('#attachments .thumb'))throw Error('typing with attachment changed composer height');return {attachmentPreviewPassed:true,inputHeight:44,formHeight};},attachmentFormHeight));
  await page.click('#send');await page.waitForFunction(()=>document.getElementById('input').value===''&&document.getElementById('attachments').classList.contains('hidden'));
  console.log(await page.evaluate(async()=>{const stats=await(await fetch('/stats')).json();if(stats.posts.length!==2||stats.posts[1].attachments[0]!=='fixture-image'||stats.uploads.length!==1||composerErrors.length)throw Error('attachment send regression');return {composerVerificationPassed:true,posts:stats.posts.length,uploads:stats.uploads.length,errors:composerErrors,...assertComposer('attachment-send-cleared')};}));
}finally{await task.finish({keep:[]});}
`;
  try{
    const output=await new Promise((resolve,reject)=>{const child=spawn('ego-browser',['nodejs'],{stdio:['pipe','pipe','pipe']});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output+=data;process.stdout.write(data);});child.on('error',reject);child.on('close',code=>code===0?resolve(output):reject(Error(output)));child.stdin.end(script);});
    assert.match(output,/composerVerificationPassed/);assert.equal(posts.length,2);assert.equal(uploads.length,1);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
