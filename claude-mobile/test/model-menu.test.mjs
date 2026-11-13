import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext,Script} from 'node:vm';
import {chatHtml} from '../backend/lib/ui.mjs';

const html=chatHtml();
const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
const client=scripts.find(source=>source.includes('function positionMenu()'));
assert.ok(client,'use the generated client code, without starting a server');
const start=client.indexOf('  let menuAnchor=');
const end=client.indexOf("  document.addEventListener('pointerdown'",start);
assert.ok(start>=0&&end>start);
const menuSource=client.slice(start,end)+'\n({openMenu,positionMenu});';
const modelCSS=html.match(/\.options-menu\.model-menu\{([^}]+)\}/)[1];
const minWidth=Number(modelCSS.match(/min-width:min\((\d+)px/)?.[1]);
const maxWidth=Number(modelCSS.match(/max-width:min\((\d+)px/)?.[1]);

const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
function element(bounds=rect(0,0,0,0)){
  const classes=new Set();
  return {
    children:[],style:{},attributes:{},isConnected:true,textContent:'',
    classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),toggle(name,on){if(on)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)},
    setAttribute(name,value){this.attributes[name]=value;},
    append(...nodes){this.children.push(...nodes);},
    replaceChildren(){this.children=[];},
    contains(node){return this===node||this.children.some(child=>child.contains(node));},
    querySelector(){return this.children.find(child=>child.className==='menu-option');},
    getBoundingClientRect:()=>bounds,getClientRects:()=>[bounds],
    focus(){this.focused=true;},
  };
}

// Execute the actual menu functions with measured DOM rectangles. The fake
// layout supplies intrinsic size and obeys the production CSS/inline bounds;
// it does not calculate positions or duplicate the positioning algorithm.
function fixture({width=393,height=852,viewport,anchorRect=rect(106,730,225,44),labelRect=rect(226,744,84,16),naturalWidth=176,naturalHeight=144,models=[]}={}){
  const menu=element(),anchor=element(anchorRect),label=labelRect&&element(labelRect);
  const nodes={optionsMenu:menu,modelLabel:label};
  Object.defineProperties(menu,{
    offsetWidth:{get(){
      const low=parseFloat(menu.style.minWidth)||(menu.classList.contains('model-menu')?minWidth:170);
      const high=parseFloat(menu.style.maxWidth)||width-20;
      return Math.min(high,Math.max(low,naturalWidth));
    }},
    offsetHeight:{get:()=>Math.min(naturalHeight,parseFloat(menu.style.maxHeight)||400)},
  });
  const state={models,model:models[0]?.model,mode:'acceptEdits'};
  const writes=[],calls={chips:0};
  const document={activeElement:null,createElement:()=>element()};
  const api=runInNewContext(menuSource,{
    $:id=>nodes[id],window:{visualViewport:viewport},innerWidth:width,innerHeight:height,
    document,state,localStorage:{setItem:(...args)=>writes.push(args)},
    updateChips:()=>calls.chips++,
  });
  return {api,menu,anchor,state,writes,calls,document,nodes,
    open(kind='model',keyboard=false){api.openMenu(kind,anchor,keyboard);},
    geometry(){return {left:parseFloat(menu.style.left),top:parseFloat(menu.style.top),width:menu.offsetWidth,height:menu.offsetHeight};},
  };
}

test('generated inline JavaScript parses and model CSS uses compact intrinsic sizing',()=>{
  for(const source of scripts)new Script(source);
  assert.match(modelCSS,/width:max-content/);
  assert.ok(minWidth>=128&&minWidth<=170);
  assert.ok(maxWidth>=minWidth&&maxWidth<=240);
  assert.match(html,/\.model-menu \.menu-option>span:first-child\{[^}]*white-space:nowrap;[^}]*text-overflow:ellipsis/);
});

test('model menu follows the visible name rather than the wide button or composer',()=>{
  const f=fixture({width:768,anchorRect:rect(20,730,600,44),labelRect:rect(340,744,84,16)});
  f.open();
  assert.equal(f.geometry().left,340);
  assert.equal(f.geometry().top+f.geometry().height,725,'five pixel gap above the trigger');
  f.nodes.modelLabel.getBoundingClientRect=()=>rect(400,744,84,16);
  f.api.positionMenu();
  assert.equal(f.geometry().left,400,'reposition when the name moves inside the same button');
});

test('short model names shrink, long model names stop at 240px',()=>{
  for(const [naturalWidth,expected] of [[90,160],[176,176],[520,240]]){
    const f=fixture({naturalWidth});f.open();
    assert.equal(f.geometry().width,expected);
  }
});

test('phone widths keep the menu close to the name and inside viewport margins',()=>{
  for(const width of [320,375,393,430]){
    const labelLeft=width-167;
    const f=fixture({width,anchorRect:rect(100,730,width-162,44),labelRect:rect(labelLeft,744,84,16),naturalWidth:160});
    f.open();const g=f.geometry();
    assert.ok(g.left>=8&&g.left+g.width<=width-8,`${width}px horizontal containment`);
    assert.ok(Math.abs(g.left-labelLeft)<=1,`${width}px menu starts beside the model name`);
    assert.ok(g.top>=8&&g.top+g.height<=852-8);
  }
});

test('visual viewport offsets, zoom and keyboard limit dimensions before measurement',()=>{
  const viewport={offsetLeft:30,offsetTop:180,width:150,height:300};
  const f=fixture({viewport,anchorRect:rect(48,390,115,44),labelRect:rect(80,404,60,16),naturalWidth:520,naturalHeight:500});
  f.open();const g=f.geometry();
  assert.equal(g.width,134,'visual viewport overrides CSS minimum and maximum');
  assert.ok(g.left>=38&&g.left+g.width<=172);
  assert.ok(g.top>=188&&g.top+g.height<=472);
  assert.ok(g.top+g.height<=386,'opens above trigger while respecting viewport top margin');
});

test('menu opens below a top trigger and flips above a bottom trigger',()=>{
  for(const [top,below] of [[20,true],[760,false]]){
    const f=fixture({anchorRect:rect(100,top,230,44),labelRect:rect(220,top+14,80,16)});
    f.open();const g=f.geometry();
    if(below)assert.equal(g.top,top+44+5);
    else assert.equal(g.top+g.height,top-5);
  }
});

test('missing or unmeasured model text falls back to trigger start',()=>{
  for(const labelRect of [null,rect(0,0,0,0)]){
    const f=fixture({width:768,anchorRect:rect(200,730,400,44),labelRect});
    f.open();assert.equal(f.geometry().left,200);
  }
});

test('model labels hide joybuilder suffixes and metadata while titles preserve identity',()=>{
  const models=[
    {model:'claude-opus-4-6-joybuilder-20261113',label:'Opus 4.6-joybuilder-20261113 · 网关'},
    {model:'claude-sonnet-4-6-joybuilder',label:'Sonnet 4.6 · claude-sonnet-4-6-joybuilder'},
    {model:'custom',label:'Custom_JOYBUILDER_internal'},
    {model:'plain',label:'Plain model'},
    {model:'fallback-joybuilder'},
  ];
  const f=fixture({models});f.open();
  assert.deepEqual(f.menu.children.map(option=>option.children[0].textContent),['Opus 4.6','Sonnet 4.6','Custom','Plain model','fallback']);
  for(const [index,option] of f.menu.children.entries()){
    assert.ok(option.title.includes(models[index].label||models[index].model));
    assert.ok(option.title.includes(models[index].model));
    assert.equal(option.attributes.role,'menuitemradio');
    assert.equal(option.attributes['aria-checked'],String(index===0));
  }
  f.menu.children[1].onclick();
  assert.equal(f.state.model,models[1].model,'selection retains exact model ID');
  assert.deepEqual(f.writes,[['clm-model',models[1].model]]);
  assert.equal(f.calls.chips,1);
  assert.ok(f.menu.classList.contains('hidden'));
});

test('keyboard model selection focuses an option and restores trigger focus',()=>{
  const f=fixture({models:[{model:'opus',label:'Opus'}]});f.open('model',true);
  assert.ok(f.menu.children[0].focused);
  f.menu.children[0].onclick();
  assert.ok(f.anchor.focused);
  assert.equal(f.anchor.attributes['aria-expanded'],'false');
});

test('other menus retain right alignment and clear model-specific sizing',()=>{
  const f=fixture();f.open();f.open('mode');
  assert.equal(f.menu.style.minWidth,'');
  assert.equal(f.menu.style.maxWidth,'377px');
  assert.equal(f.geometry().left,331-f.geometry().width);
  assert.equal(f.menu.classList.contains('model-menu'),false);
  assert.deepEqual(f.menu.children.slice(0,4).map(option=>option.children[0].textContent),['执行前确认','自动接受编辑','计划模式','完全放行']);
});

test('scrolling the trigger outside the visual viewport closes the menu',()=>{
  const f=fixture();f.open();
  f.anchor.getBoundingClientRect=()=>rect(100,-100,225,44);
  f.api.positionMenu();
  assert.ok(f.menu.classList.contains('hidden'));
  assert.equal(f.anchor.attributes['aria-expanded'],'false');
});
