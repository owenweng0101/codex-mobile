import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {marked} from '../backend/vendor/marked.esm.js';

const assistantSource=readFileSync(new URL('../backend/lib/assistant-view.js',import.meta.url),'utf8');
const source=readFileSync(new URL('../backend/lib/message-renderer.js',import.meta.url),'utf8');

// A small DOM boundary stub (native selection is also checked in a browser): run the real renderer and vendored marked
// without network, layout, dependencies or real timers. Media events are explicit.
function harness(){
  let document;
  const selection={rangeCount:0,anchorNode:null,focusNode:null,anchorOffset:0,focusOffset:0,calls:0,setBaseAndExtent(a,ao,f,fo){this.rangeCount=1;this.anchorNode=a;this.anchorOffset=ao;this.focusNode=f;this.focusOffset=fo;this.calls++;}};
  class Node {
    constructor(tag='',text=''){this.tagName=tag.toUpperCase();this.value=text;this.attrs=new Map();this.children=[];this.parentNode=null;this.style={};this.inert=false;this.ownerDocument=document;this.scrollLeft=0;this.scrollTop=0;}
    get childNodes(){return this.children;}
    get nodeType(){return this.tagName?1:3;}
    get data(){return this.value;}
    set data(value){this.value=value;if(selection.anchorNode===this)selection.anchorOffset=0;if(selection.focusNode===this)selection.focusOffset=0;}
    get lastChild(){return this.children.at(-1)||null;}
    get outerHTML(){return this.nodeType===3?this.value:'<'+this.tagName+JSON.stringify([...this.attrs])+ '>'+this.children.map(n=>n.nodeType===3?n.data:n.outerHTML).join('')+'</'+this.tagName+'>';}
    isEqualNode(other){return this.nodeType===other.nodeType&&this.tagName===other.tagName&&this.value===other.value&&this.attrs.size===other.attrs.size&&[...this.attrs].every(([k,v])=>other.getAttribute(k)===v)&&this.children.length===other.children.length&&this.children.every((child,i)=>child.isEqualNode(other.children[i]));}
    insertBefore(node,before){node.remove();const index=before?this.children.indexOf(before):this.children.length;if(index<0)throw Error('reference child missing');node.parentNode=this;this.children.splice(index,0,node);}

    get textContent(){return this.tagName?this.children.map(n=>n.textContent).join(''):this.value;}
    set textContent(value){if(this.tagName)this.replaceChildren(new Node('',String(value)));else this.value=String(value);}
    get attributes(){return [...this.attrs].map(([name,value])=>({name,value}));}
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
    querySelectorAll(selector){if(selector.includes(','))return [...new Set(selector.split(',').flatMap(s=>this.querySelectorAll(s)))];const result=[];for(const child of this.children){if(child.matches(selector))result.push(child);result.push(...child.querySelectorAll(selector));}return result;}
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
  document={createElement:tag=>new Node(tag),createTextNode:text=>new Node('',text),addEventListener:(type,listener)=>listeners.set(type,listener),activeElement:null,getSelection:()=>selection};
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
  vm.runInNewContext(assistantSource,{window,document});
  const container=new Node('div');document.body.append(container);
  const viewer=document.body.querySelector('.file-view'),content=viewer.querySelector('.file-content');
  return {window,document,container,viewer,content,requests,timers,selection,create:()=>window.createClaudeAssistant({container,renderText:(node,text)=>window.claudeRender(node,text,'test-session')}),
    render:(text,base)=>window.claudeRender(container,text,'session-中文',base),
    response:(type,text='',ok=true,status=200)=>{respond=async()=>({ok,status,headers:{get:()=>type},text:async()=>text});},
    fetch:callback=>{respond=callback;},
    close:()=>viewer.querySelector('button').onclick(),
    expire:()=>{for(const [id,callback] of [...timers]){timers.delete(id);callback();}},
    key:key=>listeners.get('keydown')({key,preventDefault(){}})
  };
}
const table='|A|B|C|D|E|F|\n|-|-|-|-|-|-|\n|1|2|3|4|5|6|\n';
const firstText=node=>node.nodeType===3?node:firstText(node.childNodes[0]);

test('unchanged table and selected paragraph keep DOM identity across a later block',()=>{
  const h=harness(),owner=h.create();owner.appendText(table+'\nSelected paragraph.\n');
  const scroll=owner.bubble.querySelector('.table-scroll'),paragraph=owner.bubble.querySelector('p'),text=firstText(paragraph);
  scroll.scrollLeft=160;h.selection.setBaseAndExtent(text,0,text,8);const calls=h.selection.calls;
  owner.appendText('\nNext block.\n');
  assert.equal(owner.bubble.querySelector('.table-scroll'),scroll);assert.equal(scroll.scrollLeft,160);
  assert.equal(owner.bubble.querySelector('p'),paragraph);assert.equal(h.selection.anchorNode,text);assert.equal(h.selection.focusOffset,8);
  assert.equal(h.selection.calls,calls,'do not reset an untouched native selection');
});

test('growing tables preserve wrapper, existing cells and horizontal scroll',()=>{
  const h=harness(),owner=h.create();owner.appendText(table);
  const scroll=owner.bubble.querySelector('.table-scroll'),cell=owner.bubble.querySelector('td');scroll.scrollLeft=120;
  owner.appendText('|7|8|9|10|11|12|\n');
  assert.equal(owner.bubble.querySelector('.table-scroll'),scroll);assert.equal(scroll.scrollLeft,120);
  assert.equal(owner.bubble.querySelector('td'),cell);assert.equal(owner.bubble.querySelectorAll('td').length,12);
});

test('appending inside an open code fence preserves code node, selection and scroll',()=>{
  const h=harness(),owner=h.create();owner.appendText('```js\nconst value = 1;');
  const pre=owner.bubble.querySelector('pre'),code=pre.querySelector('code'),text=firstText(code);pre.scrollLeft=90;
  h.selection.setBaseAndExtent(text,6,text,11);owner.appendText('\nconst next = 2;\n```');
  assert.equal(owner.bubble.querySelector('pre'),pre);assert.equal(pre.querySelector('code'),code);assert.equal(pre.scrollLeft,90);
  assert.equal(h.selection.anchorOffset,6);assert.equal(h.selection.focusOffset,11);assert.equal(h.selection.anchorNode,text);
});

test('closing emphasis rebuilds affected inline structure and remaps selection',()=>{
  const h=harness(),owner=h.create();owner.appendText('**hello');
  const text=firstText(owner.bubble.querySelector('p'));h.selection.setBaseAndExtent(text,2,text,7);
  owner.appendText('**');const strong=owner.bubble.querySelector('strong');
  assert.equal(strong.textContent,'hello');assert.equal(h.selection.anchorNode,firstText(strong));
  assert.equal(h.selection.anchorOffset,0);assert.equal(h.selection.focusOffset,5);
});

test('structural Markdown promotion from paragraph to table restores selection',()=>{
  const h=harness(),owner=h.create();owner.appendText('|hello|world|\n');
  const text=firstText(owner.bubble.querySelector('p'));h.selection.setBaseAndExtent(text,1,text,6);
  owner.appendText('|-|-|\n|1|2|\n');const heading=firstText(owner.bubble.querySelector('th'));
  assert.ok(owner.bubble.querySelector('.table-scroll').contains(h.selection.anchorNode));
  assert.equal(h.selection.focusNode,heading);assert.equal(h.selection.focusOffset,5);
  assert.ok(h.selection.anchorNode===heading&&h.selection.anchorOffset===0||h.selection.anchorNode.data==='\n'&&h.selection.anchorOffset===1,'start can be the equivalent boundary after a preceding newline');
});

test('late reference definitions reparse earlier text and keep the unchanged table',()=>{
  const h=harness(),owner=h.create();owner.appendText('[hello][ref]\n\n'+table);
  const scroll=owner.bubble.querySelector('.table-scroll');scroll.scrollLeft=110;
  const text=firstText(owner.bubble.querySelector('p'));h.selection.setBaseAndExtent(text,1,text,6);
  owner.appendText('\n[ref]: https://example.com\n');const link=owner.bubble.querySelector('a');
  assert.equal(link.href,'https://example.com');assert.equal(owner.bubble.querySelector('.table-scroll'),scroll);
  assert.equal(scroll.scrollLeft,110);assert.equal(h.selection.anchorNode,firstText(link));assert.equal(h.selection.anchorOffset,0);assert.equal(h.selection.focusOffset,5);
});

test('backward selection survives replacement of Markdown delimiters',()=>{
  const h=harness(),owner=h.create();owner.appendText('**hello');const text=firstText(owner.bubble.querySelector('p'));
  h.selection.setBaseAndExtent(text,7,text,2);owner.appendText('**');
  assert.equal(h.selection.anchorOffset,5);assert.equal(h.selection.focusOffset,0);
});

test('selection outside the updating bubble is untouched',()=>{
  const h=harness(),outside=h.document.createTextNode('outside');h.document.body.append(outside);
  h.selection.setBaseAndExtent(outside,0,outside,4);const calls=h.selection.calls;
  const owner=h.create();owner.appendText('text');owner.appendText(' more');assert.equal(h.selection.calls,calls);assert.equal(h.selection.anchorNode,outside);
});

test('changed file links receive handlers bound to their new label',()=>{
  const h=harness(),owner=h.create();owner.appendText('[old](/tmp/file.md)');
  const old=owner.bubble.querySelector('a');owner.segmentText='';owner.text='';owner.appendText('[new](/tmp/file.md)');
  const link=owner.bubble.querySelector('a');assert.notEqual(link,old);assert.equal(link.textContent,'new');assert.equal(typeof link.onclick,'function');
  link.onclick({preventDefault(){}});assert.equal(h.viewer.querySelector('strong').textContent,'new');
});

test('duplicate equal blocks remain distinct and empty appends preserve nodes',()=>{
  const h=harness(),owner=h.create();owner.appendText('same\n\nsame\n');const [a,b]=owner.bubble.querySelectorAll('p');owner.appendText('');
  const paragraphs=owner.bubble.querySelectorAll('p');assert.equal(paragraphs[0],a);assert.equal(paragraphs[1],b);assert.notEqual(a,b);
});
