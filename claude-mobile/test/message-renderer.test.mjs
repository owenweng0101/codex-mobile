import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {marked} from '../backend/vendor/marked.esm.js';

const source=readFileSync(new URL('../backend/lib/message-renderer.js',import.meta.url),'utf8');

// A small tree/event stub, not a browser: run the real renderer and vendored marked
// without network, layout, dependencies or real timers. Media events are explicit.
function harness(){
  let document;
  class Node {
    constructor(tag='',text=''){this.tagName=tag.toUpperCase();this.value=text;this.attrs=new Map();this.children=[];this.parentNode=null;this.style={};this.inert=false;}
    get childNodes(){return this.children;}
    get textContent(){return this.tagName?this.children.map(n=>n.textContent).join(''):this.value;}
    set textContent(value){if(this.tagName)this.replaceChildren(new Node('',String(value)));else this.value=String(value);}
    get attributes(){return [...this.attrs.keys()].map(name=>({name}));}
    setAttribute(k,v){this.attrs.set(k,String(v));}
    getAttribute(k){return this.attrs.get(k)??null;}
    hasAttribute(k){return this.attrs.has(k);}
    removeAttribute(k){this.attrs.delete(k);}
    get className(){return this.getAttribute('class')||'';}
    set className(v){this.setAttribute('class',v);}
    get classList(){return {add:(...names)=>{this.className=[...new Set([...this.className.split(/\s+/).filter(Boolean),...names])].join(' ');},remove:(...names)=>{this.className=this.className.split(/\s+/).filter(n=>!names.includes(n)).join(' ');},contains:name=>this.className.split(/\s+/).includes(name)};}
    append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
    replaceChildren(...nodes){for(const child of this.children)child.parentNode=null;this.children=[];this.append(...nodes);}
    remove(){if(this.parentNode){const siblings=this.parentNode.children;siblings.splice(siblings.indexOf(this),1);this.parentNode=null;}}
    replaceWith(node){const parent=this.parentNode,index=parent.children.indexOf(this);node.remove();parent.children[index]=node;node.parentNode=parent;this.parentNode=null;}
    after(node){node.remove();const parent=this.parentNode;parent.children.splice(parent.children.indexOf(this)+1,0,node);node.parentNode=parent;}
    matches(selector){if(!this.tagName)return false;if(selector==='*')return true;if(selector.includes(':not(:disabled)')&&this.disabled)return false;selector=selector.replace(':not(:disabled)','');const match=/^([\w-]+)?(?:\.([\w-]+))?$/.exec(selector);return !!match&&(!match[1]||this.tagName===match[1].toUpperCase())&&(!match[2]||this.classList.contains(match[2]));}
    querySelectorAll(selector){const result=[];for(const child of this.children){if(child.matches(selector))result.push(child);result.push(...child.querySelectorAll(selector));}return result;}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    closest(selector){for(let node=this;node;node=node.parentNode)if(node.matches(selector))return node;return null;}
    contains(node){return node===this||this.children.some(child=>child.contains(node));}
    get isConnected(){return this===document.body||!!this.parentNode?.isConnected;}
    focus(){document.activeElement=this;}
    getClientRects(){return this.isConnected?[{}]:[];}
    setPointerCapture(){}
  }
  for(const property of ['src','href','alt','title'])Object.defineProperty(Node.prototype,property,{get(){return this.getAttribute(property)||'';},set(value){this.setAttribute(property,value);}});
  const listeners=new Map();
  document={createElement:tag=>new Node(tag),createTextNode:text=>new Node('',text),addEventListener:(type,listener)=>listeners.set(type,listener),activeElement:null};
  document.body=new Node('body');
  const decode=text=>text.replace(/&(?:amp|quot|lt|gt|#39);/g,match=>({'&amp;':'&','&quot;':'"','&lt;':'<','&gt;':'>','&#39;':"'"}[match]));
  class DOMParser {
    parseFromString(html){
      const body=new Node('body'),stack=[body];
      for(const token of html.match(/<[^>]*>|[^<]+/g)||[]){
        if(token.startsWith('</')){if(stack.length>1)stack.pop();continue;}
        if(token.startsWith('<')){
          const name=/^<([\w-]+)/.exec(token)?.[1];if(!name)continue;
          const node=new Node(name);
          for(const attr of token.slice(name.length+1).matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))node.setAttribute(attr[1],decode(attr[2]??attr[3]??attr[4]??''));
          stack.at(-1).append(node);if(!/^(img|br|hr|input)$/i.test(name))stack.push(node);
        }else stack.at(-1).append(new Node('',decode(token)));
      }
      return {body,createElement:document.createElement};
    }
  }
  const timers=new Map(),requests=[];let timerId=0;
  let respond=async()=>({ok:true,headers:{get:()=> 'text/plain'},text:async()=>''});
  const window={};
  vm.runInNewContext(source,{window,document,DOMParser,marked,AbortController,setTimeout:callback=>{timers.set(++timerId,callback);return timerId;},clearTimeout:id=>timers.delete(id),fetch:(url,options)=>{requests.push({url,options});return respond(url,options);}});
  const container=new Node('div');document.body.append(container);
  const viewer=document.body.querySelector('.file-view'),content=viewer.querySelector('.file-content');
  return {window,document,container,viewer,content,requests,timers,
    render:(text,base)=>window.claudeRender(container,text,'session-中文',base),
    response:(type,text='',ok=true,status=200)=>{respond=async()=>({ok,status,headers:{get:()=>type},text:async()=>text});},
    fetch:callback=>{respond=callback;},
    close:()=>viewer.querySelector('button').onclick(),
    expire:()=>{for(const [id,callback] of [...timers]){timers.delete(id);callback();}},
    key:key=>listeners.get('keydown')({key,preventDefault(){}})
  };
}
const click=node=>node.onclick({preventDefault(){},stopPropagation(){}});
const params=url=>new URL(url,'https://mobile.test').searchParams;
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('file URL images decode once, retain alt, and open the in-frame image viewer',()=>{
  const h=harness();h.render('![示意图](file:///tmp/%E5%9B%BE%2520.png)');
  const image=h.container.querySelector('img'),query=params(image.src);
  assert.equal(query.get('path'),'/tmp/图%20.png');assert.equal(query.get('session'),'session-中文');assert.equal(image.alt,'示意图');
  click(image);assert.equal(h.content.querySelector('.image-stage').querySelector('img').src,image.src);
  assert.equal(h.viewer.getAttribute('aria-modal'),'true');h.close();assert.equal(h.container.inert,false);
});

test('Markdown files reuse claudeRender and carry session/base through nested files and images',async()=>{
  const h=harness();h.response('text/plain; charset=utf-8','# 文档\n\n**重点**\n\n![图](images/chart.png)\n\n[下一章](chapters/next.md)');
  h.render('[报告](/work/docs/report.md)');await click(h.container.querySelector('a'));
  const article=h.content.querySelector('article');assert.ok(article.classList.contains('markdown-preview'));assert.equal(article.querySelector('h1').textContent,'文档');assert.equal(article.querySelector('strong').textContent,'重点');
  const image=params(article.querySelector('img').src);assert.equal(image.get('path'),'images/chart.png');assert.equal(image.get('base'),'/work/docs/report.md');assert.equal(image.get('session'),'session-中文');
  const next=article.querySelector('a');h.response('text/markdown','# 下一章\n\n[附录](../appendix.md)');await click(next);
  assert.equal(params(h.requests.at(-1).url).get('base'),'/work/docs/report.md');assert.equal(params(h.requests.at(-1).url).get('path'),'chapters/next.md');
  h.response('text/plain','# 附录');await click(h.content.querySelector('article').querySelector('a'));
  assert.equal(params(h.requests.at(-1).url).get('base'),'/work/docs/chapters/next.md');assert.equal(params(h.requests.at(-1).url).get('session'),'session-中文');assert.equal(h.content.querySelector('h1').textContent,'附录');
});

test('relative document bases remain relative to the session cwd',async()=>{
  const h=harness();h.response('text/plain','![图](../chart.png)');h.render('[报告](output/report.MARKDOWN)');await click(h.container.querySelector('a'));
  const query=params(h.content.querySelector('img').src);assert.equal(query.get('base'),'output/report.MARKDOWN');assert.equal(query.get('path'),'../chart.png');
});

test('Markdown MIME is recognized without an extension; ordinary text stays text',async()=>{
  const h=harness();h.render('[文件](/work/README)');h.response('TEXT/MARKDOWN; charset=utf-8','# 标题');await click(h.container.querySelector('a'));assert.equal(h.content.querySelector('h1').textContent,'标题');
  h.response('text/plain','# 原样保留');await click(h.container.querySelector('a'));assert.equal(h.content.querySelector('pre').textContent,'# 原样保留');assert.equal(h.content.querySelector('article'),null);
});

test('rendered documents keep sanitizer and table wrapping',async()=>{
  const h=harness();h.response('text/markdown','<img src="file:///tmp/chart.png" onerror="alert(1)">\n\n[危险](javascript:alert)\n\n|列|\n|--|\n|值|');h.render('[报告](/work/report.md)');await click(h.container.querySelector('a'));
  assert.equal(h.content.querySelector('img').getAttribute('onerror'),null);assert.equal(h.content.querySelector('a').getAttribute('href'),null);assert.ok(h.content.querySelector('.table-scroll').querySelector('table'));
});

test('HTML permits scripts without same-origin; PDF keeps scripts disabled',async()=>{
  const h=harness();h.render('[网页](/work/report.html)');h.response('text/html');await click(h.container.querySelector('a'));
  let frame=h.content.querySelector('iframe');assert.equal(frame.getAttribute('sandbox'),'allow-scripts');assert.ok(!frame.getAttribute('sandbox').includes('allow-same-origin'));assert.ok(h.content.querySelector('.media-status'));
  frame.onload();assert.equal(h.timers.size,0);assert.equal(h.content.querySelector('.media-status'),null);
  h.response('application/pdf');await click(h.container.querySelector('a'));frame=h.content.querySelector('iframe');assert.equal(frame.getAttribute('sandbox'),'');
});

test('inline image failures show a retry and retain the authorized URL',()=>{
  const h=harness();h.render('![图](./chart.png)','/work/report.md');const image=h.container.querySelector('img'),url=image.src;
  image.onerror();assert.equal(image.hidden,true);assert.match(h.container.textContent,/图片加载失败/);assert.equal(h.container.querySelectorAll('.inline-image-error').length,1);
  image.onerror();assert.equal(h.container.querySelectorAll('.inline-image-error').length,1);
  click(h.container.querySelector('button'));assert.equal(image.hidden,false);assert.equal(image.src,url);assert.equal(h.container.querySelector('.inline-image-error'),null);
});

test('image viewer handles load, failure, retry, timeout and obsolete callbacks',()=>{
  const h=harness();h.window.claudePreviewImage('/image/one','一');let image=h.content.querySelector('img');image.onload();assert.equal(h.timers.size,0);assert.equal(h.content.querySelector('.media-status'),null);
  h.window.claudePreviewImage('/image/two','二');image=h.content.querySelector('img');image.onerror();assert.match(h.content.textContent,/图片加载失败/);click(h.content.querySelector('button'));assert.equal(h.content.querySelector('img').src,'/image/two');
  h.expire();assert.match(h.content.textContent,/图片仍未加载/);click(h.content.querySelector('button'));const obsolete=h.content.querySelector('img');h.close();obsolete.onerror();assert.equal(h.content.children.length,0);assert.equal(h.timers.size,0);
});

test('iframe failure/timeout is actionable and a late load clears its timeout notice',async()=>{
  const h=harness();h.render('[网页](/work/report.html)');h.response('text/html');await click(h.container.querySelector('a'));
  let frame=h.content.querySelector('iframe');frame.onerror();assert.match(h.content.textContent,/预览加载失败/);await click(h.content.querySelector('button'));
  frame=h.content.querySelector('iframe');h.expire();assert.match(h.content.textContent,/仍未完成加载/);assert.ok(h.content.querySelector('button'));frame.onload();assert.equal(h.content.querySelector('.media-status'),null);
  await click(h.container.querySelector('a'));frame=h.content.querySelector('iframe');h.close();frame.onerror();assert.equal(h.content.children.length,0);assert.equal(h.timers.size,0);
});

test('HTTP and network failures expose retry; aborted old responses cannot replace the current preview',async()=>{
  const h=harness();h.render('[文件](/work/report.md)');h.response('text/plain','',false,403);await click(h.container.querySelector('a'));assert.match(h.content.textContent,/403/);
  h.response('text/plain','# 恢复');await click(h.content.querySelector('button'));assert.equal(h.content.querySelector('h1').textContent,'恢复');
  h.fetch(async()=>{throw new Error('网络不可用');});await click(h.container.querySelector('a'));assert.match(h.content.textContent,/网络不可用/);assert.ok(h.content.querySelector('button'));
  let resolve;h.fetch(()=>new Promise(done=>{resolve=done;}));const pending=click(h.container.querySelector('a')),signal=h.requests.at(-1).options.signal;
  h.window.claudePreviewImage('/current.png','当前');assert.equal(signal.aborted,true);resolve({ok:true,headers:{get:()=> 'text/markdown'},text:async()=> '# 旧文档'});await pending;await turn();assert.equal(h.content.querySelector('img').src,'/current.png');assert.equal(h.content.querySelector('article'),null);
});

test('a stalled file request times out with retry instead of remaining on the loading screen',async()=>{
  const h=harness();h.render('[报告](/work/report.md)');
  h.fetch((url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})))));
  const pending=click(h.container.querySelector('a'));assert.match(h.content.textContent,/正在读取/);h.expire();await pending;
  assert.match(h.content.textContent,/文件读取超时/);assert.equal(h.timers.size,0);
  h.response('text/markdown','# 恢复');await click(h.content.querySelector('button'));assert.equal(h.content.querySelector('h1').textContent,'恢复');
});

test('loading and timeout cover the response body, and an obsolete body cannot replace a newer preview',async()=>{
  const h=harness();h.render('[报告](/work/report.md)');let resolveBody;
  h.fetch(async(url,{signal})=>({ok:true,headers:{get:()=> 'text/markdown'},text:()=>new Promise((resolve,reject)=>{
    resolveBody=resolve;
    signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})));
  })}));
  const pending=click(h.container.querySelector('a'));await turn();assert.match(h.content.textContent,/正在读取/);h.expire();await pending;assert.match(h.content.textContent,/文件读取超时/);
  h.fetch(async()=>({ok:true,headers:{get:()=> 'text/markdown'},text:()=>new Promise(resolve=>{resolveBody=resolve;})}));
  const old=click(h.container.querySelector('a'));await turn();h.window.claudePreviewImage('/new.png','新');resolveBody('# 旧内容');await old;
  assert.equal(h.content.querySelector('img').src,'/new.png');assert.equal(h.timers.size,1);h.content.querySelector('img').onload();assert.equal(h.timers.size,0);
});

test('viewer teardown restores only the child document and Escape closes the preview',()=>{
  const h=harness(),existing=h.document.createElement('aside');existing.inert=true;h.document.body.append(existing);
  const trigger=h.document.createElement('button');h.container.append(trigger);trigger.focus();h.window.claudePreviewImage('/chart.png','图');assert.equal(h.container.inert,true);
  h.key('Escape');assert.equal(h.container.inert,false);assert.equal(existing.inert,true);assert.equal(h.document.activeElement,trigger);assert.ok(h.viewer.classList.contains('hidden'));
});

test('inline data:image URLs render within the cap and oversized ones show a placeholder',()=>{
  const h=harness();
  const image='data:image/png;base64,iVBORw0KGgo=';
  h.render('前\n\n![内联图]('+image+')\n\n后');
  const node=h.container.querySelector('img');
  assert.equal(node.src,image);assert.equal(node.alt,'内联图');
  click(node);assert.equal(h.content.querySelector('.image-stage').querySelector('img').src,image);
  h.close();
  h.render('![太大]('+'data:image/png;base64,'+'A'.repeat(2*1024*1024)+')');
  assert.equal(h.container.querySelector('img'),null);
  assert.match(h.container.textContent,/图片过大，无法显示/);
  const placeholder=h.container.querySelector('.inline-image-too-large');
  assert.ok(placeholder.classList.contains('preview-status'));
  assert.equal(placeholder.querySelector('button'),null);
  // Non-image data URLs are still invalid values: no source, no preview hook.
  h.render('![脚本](data:text/html;base64,PHNjcmlwdD4=)');
  const dropped=h.container.querySelector('img');
  assert.equal(dropped.getAttribute('src'),null);
  assert.equal(dropped.onclick,undefined);
});
