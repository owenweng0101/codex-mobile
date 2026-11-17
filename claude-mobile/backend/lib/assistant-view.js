/* Ordered assistant output: one compact process summary between adjacent text blocks. */
(() => {
  // Streaming appends re-render only the final, still-open Markdown block: a
  // blank line closes a block, so everything before it is stable and keeps its
  // DOM. Fenced code, reference definitions and raw HTML can change earlier
  // output, so those fall back to a full pass. Never morph a changed interactive
  // element: its renderer-owned handlers close over that node.
  const stableViews=new WeakMap();
  const interactive=new Set(['A','IMG','INPUT','BUTTON','IFRAME','VIDEO','AUDIO']);
  const nodeText=node=>node.textContent||'';
  const signature=node=>node.nodeType===3?'text:'+node.data:node.outerHTML;
  const compatible=(a,b)=>a.nodeType===b.nodeType&&(a.nodeType===3||a.nodeType===1&&a.tagName===b.tagName&&!interactive.has(a.tagName)&&a.attributes.length===b.attributes.length&&[...a.attributes].every(attr=>b.getAttribute(attr.name)===attr.value));
  function reconcile(parent,fresh,from=0){
    const old=[...parent.childNodes].slice(from),next=[...fresh.childNodes],used=new Set(),matches=new Map(),buckets=new Map();
    for(const node of old){const key=signature(node);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(node);}
    // Reserve all equal nodes before matching changed nodes, so an insertion
    // cannot consume a later unchanged paragraph or table as a positional match.
    for(const node of next){const match=buckets.get(signature(node))?.find(item=>!used.has(item)&&item.isEqualNode(node));if(match){matches.set(node,match);used.add(match);}}
    for(let index=0;index<next.length;index++){
      const node=next[index];if(matches.has(node))continue;
      const match=old[index]&&!used.has(old[index])&&compatible(old[index],node)?old[index]:old.find(item=>!used.has(item)&&compatible(item,node));
      if(match){matches.set(node,match);used.add(match);}
    }
    for(let index=0;index<next.length;index++){
      const node=next[index],live=matches.get(node)||node;
      if(live!==node&&!live.isEqualNode(node)){
        if(live.nodeType===3)live.data=node.data;else reconcile(live,node);
      }
      if(parent.childNodes[from+index]!==live)parent.insertBefore(live,parent.childNodes[from+index]||null);
    }
    while(parent.childNodes.length>from+next.length)parent.lastChild.remove();
  }
  function textOffset(root,node,offset){
    let total=0,found=false;
    const visit=current=>{
      if(current===node){total+=current.nodeType===3?offset:[...current.childNodes].slice(0,offset).reduce((sum,child)=>sum+nodeText(child).length,0);found=true;return;}
      if(current.nodeType===3){total+=current.data.length;return;}
      for(const child of current.childNodes){visit(child);if(found)return;}
    };
    visit(root);return total;
  }
  function textPoint(root,offset){
    let remaining=Math.max(0,offset),last=null;
    const visit=node=>{
      if(node.nodeType===3){last=node;if(remaining<=node.data.length)return [node,remaining];remaining-=node.data.length;return null;}
      for(const child of node.childNodes){const point=visit(child);if(point)return point;}
      return null;
    };
    return visit(root)||(last?[last,last.data.length]:[root,0]);
  }
  function captureSelection(root){
    const selection=root.ownerDocument?.getSelection?.();
    if(!selection?.rangeCount||!root.contains(selection.anchorNode)&&!root.contains(selection.focusNode))return null;
    const point=(node,offset)=>({node,offset,inside:root.contains(node),text:nodeText(node),children:[...node.childNodes],position:root.contains(node)?textOffset(root,node,offset):null});
    return {selection,anchor:point(selection.anchorNode,selection.anchorOffset),focus:point(selection.focusNode,selection.focusOffset),text:nodeText(root)};
  }
  function restoreSelection(root,saved){
    if(!saved)return;
    const {selection,anchor,focus}=saved,newText=nodeText(root);
    const intact=point=>!point.inside||root.contains(point.node)&&nodeText(point.node)===point.text&&point.children.length===point.node.childNodes.length&&point.children.every((child,index)=>child===point.node.childNodes[index]);
    if(intact(anchor)&&intact(focus)&&selection.anchorNode===anchor.node&&selection.anchorOffset===anchor.offset&&selection.focusNode===focus.node&&selection.focusOffset===focus.offset)return;
    let prefix=0,suffix=0;
    while(prefix<saved.text.length&&prefix<newText.length&&saved.text[prefix]===newText[prefix])prefix++;
    while(suffix<saved.text.length-prefix&&suffix<newText.length-prefix&&saved.text[saved.text.length-1-suffix]===newText[newText.length-1-suffix])suffix++;
    const map=offset=>offset<=prefix?offset:offset>=saved.text.length-suffix?newText.length-(saved.text.length-offset):Math.min(newText.length-suffix,prefix+offset-prefix);
    let start=null,end=null;
    if(anchor.inside&&focus.inside){
      const from=Math.min(anchor.position,focus.position),to=Math.max(anchor.position,focus.position),quote=saved.text.slice(from,to);
      if(quote){let best=-1,distance=Infinity;for(let at=newText.indexOf(quote);at>=0;at=newText.indexOf(quote,at+1)){const delta=Math.abs(at-map(from));if(delta<distance){best=at;distance=delta;}}if(best>=0){start=best;end=best+quote.length;}}
    }
    const backwards=anchor.position>focus.position;
    const resolve=(point,isAnchor)=>{
      if(intact(point))return [point.node,point.offset];
      const offset=start===null?map(point.position):(isAnchor===!backwards?start:end);
      return textPoint(root,offset);
    };
    const a=resolve(anchor,true),f=resolve(focus,false);
    if(selection.setBaseAndExtent)selection.setBaseAndExtent(...a,...f);
    else{const range=root.ownerDocument.createRange();range.setStart(...a);range.collapse(true);selection.removeAllRanges();selection.addRange(range);selection.extend?.(...f);}
  }
  const blankLine=/^[ \t]*$/;
  const fenceOpen=/^ {0,3}(`{3,}|~{3,})/;
  const fenceClose=/^ {0,3}(`+|~+)[ \t]*$/;
  const definitionLine=/^ {0,3}\[[^\]\n]+\]:/;
  const htmlBlock=/^ {0,3}<[A-Za-z/!?]/;
  const listLine=/^[ \t]*([-*+]|\d{1,9}[.)])([ \t]|$)/;
  const indentedLine=/^( {4}|\t)/;
  const quotedLine=/^ {0,3}>/;
  const indentedAny=/^[ \t]/;
  // A line is an open block boundary only outside fences. "scanned" is the start
  // of the last, still incomplete line, so an append only scans its new lines.
  function scanNewLines(scan,text){
    let index=scan.scanned;
    for(;;){
      const end=text.indexOf('\n',index);if(end<0)break;
      const line=text.slice(index,end);
      if(scan.fence){
        const close=fenceClose.exec(line);
        if(close&&close[1][0]===scan.fence.char&&close[1].length>=scan.fence.len)scan.fence=null;
      }else{
        const fence=fenceOpen.exec(line);
        if(fence)scan.fence={char:fence[1][0],len:fence[1].length,start:index,indent:fence[0].length-fence[1].length};
        else{
          if(definitionLine.test(line))scan.definitions=true;
          else if(htmlBlock.test(line))scan.unsafe=true;
          if(blankLine.test(line))scan.blank=end+1;
        }
      }
      index=end+1;
    }
    // The unterminated last line can already contain a reference definition or
    // raw HTML; both make earlier blocks re-render, so detect them early. Fence
    // state and blank-line positions wait until the line is complete.
    if(index<text.length){
      const rest=text.slice(index);
      if(definitionLine.test(rest))scan.definitions=true;
      else if(htmlBlock.test(rest))scan.unsafe=true;
    }
    scan.scanned=index;
  }
  // Start of the last block that is not closed yet (0 when nothing is stable).
  // Blocks that merge across a blank line with what follows stay in the tail.
  function openBlockStart(scan,text){
    if(scan.definitions||scan.unsafe)return 0;
    let start=scan.fence?(scan.fence.indent===0?scan.fence.start:0):scan.blank;
    const lineStart=position=>{
      if(position<=0)return 0;
      const index=text.lastIndexOf('\n',position-1);
      return index<0?0:index+1;
    };
    const lineEnd=position=>{const index=text.indexOf('\n',position);return index<0?text.length:index;};
    const lineText=position=>text.slice(position,lineEnd(position));
    while(start>0){
      let previous=lineStart(start-1);
      while(previous>0&&blankLine.test(lineText(previous)))previous=lineStart(previous-1);
      if(blankLine.test(lineText(previous)))break;
      let block=previous;
      while(block>0&&!blankLine.test(lineText(lineStart(block-1))))block=lineStart(block-1);
      const first=lineText(block);
      if(htmlBlock.test(first))return 0;
      if(listLine.test(first)||indentedLine.test(first)||quotedLine.test(first)||indentedAny.test(first)){start=block;continue;}
      break;
    }
    return start;
  }
  function renderStable(root,text,renderText){
    // The lightweight non-DOM consumers used by transcript tests still receive
    // the exact same rendering callback. Browser elements always use reconciliation.
    if(!root.ownerDocument?.createElement||!root.insertBefore){renderText(root,text);return;}
    const previous=stableViews.get(root);if(previous&&previous.text===text)return;
    const scan=previous&&text.startsWith(previous.text)
      ? {scanned:previous.scan.scanned,fence:previous.scan.fence,blank:previous.scan.blank,definitions:previous.scan.definitions,unsafe:previous.scan.unsafe}
      : {scanned:0,fence:null,blank:0,definitions:false,unsafe:false};
    scanNewLines(scan,text);
    const start=openBlockStart(scan,text),prefix=text.slice(0,start),tail=text.slice(start);
    const document=root.ownerDocument;
    const renderInto=value=>{const fresh=document.createElement('div');renderText(fresh,value);return fresh;};
    const selection=captureSelection(root);
    const scrollers=[root,...root.querySelectorAll('.table-scroll,pre')];
    const positions=scrollers.map((node,index)=>({node,index,left:node.scrollLeft,top:node.scrollTop,text:nodeText(node),tag:node.tagName})).filter(point=>point.left||point.top);
    let state;
    if(previous&&previous.count!==null&&text.startsWith(previous.text)&&start>=previous.committed.length){
      // Reuse the committed prefix and the previous tail DOM: render only what
      // became stable since the last append plus the tail that is still open.
      const promoted=text.slice(previous.committed.length,start);
      const freshPromoted=promoted?renderInto(promoted):null;
      const freshTail=tail?renderInto(tail):null;
      let count=Math.min(previous.count,root.childNodes.length);
      if(freshPromoted){const promotedCount=freshPromoted.childNodes.length;reconcile(root,freshPromoted,count);count+=promotedCount;}
      if(freshTail)reconcile(root,freshTail,count);
      else while(root.childNodes.length>count)root.lastChild.remove();
      state={text,committed:prefix,count,scan};
    }else{
      // Full pass: prefix and tail are rendered separately but reconciled as one
      // document, so unchanged blocks keep their nodes, handlers and selection.
      const fresh=prefix?renderInto(prefix):document.createElement('div');
      const freshTail=tail?renderInto(tail):document.createElement('div');
      const prefixCount=fresh.childNodes.length;
      for(const node of [...freshTail.childNodes])fresh.append(node);
      reconcile(root,fresh,0);
      state={text,committed:prefix,count:prefixCount,scan};
    }
    const current=[root,...root.querySelectorAll('.table-scroll,pre')];
    for(const point of positions){const node=root.contains(point.node)?point.node:current.find(item=>item.tagName===point.tag&&nodeText(item)===point.text)||current[point.index];if(node?.tagName===point.tag){node.scrollLeft=point.left;node.scrollTop=point.top;}}
    restoreSelection(root,selection);stableViews.set(root,state);
  }
  window.createClaudeAssistant=({container,renderText})=>{
    const wrap=document.createElement('div');wrap.className='msg assistant';container.append(wrap);
    const owner={wrap,text:'',bubble:null,think:null,thinkBody:null,tools:null,activity:null,lastKind:null,segmentText:'',textBoundary:null,processes:[],thoughts:[],toolMap:new Map(),
      ensureProcess(){
        if(this.lastKind==='process')return this.processes.at(-1);
        const details=document.createElement('details');details.className='activity';const summary=document.createElement('summary');const content=document.createElement('div');content.className='process-content';details.append(summary,content);wrap.append(details);
        const group={details,summary,content,items:new Map(),thinking:false,lastType:null,currentThink:null,currentTools:null,terminal:null};this.processes.push(group);this.lastKind='process';this.activity=details;return group;
      },
      ensureThink(){
        const group=this.ensureProcess();group.thinking=true;
        if(group.lastType==='thinking'&&group.currentThink){const thought=group.currentThink;thought.label.textContent='正在思考';if(!thought.spark.parentNode)thought.details.querySelector('summary').append(thought.spark,thought.label);this.updateActivity();return thought.body;}
        const details=document.createElement('details');details.className='think';const summary=document.createElement('summary');const spark=document.createElement('span');spark.className='spark';const label=document.createElement('span');label.className='think-label';label.textContent='正在思考';const body=document.createElement('div');body.className='body';summary.append(spark,label);details.append(summary,body);group.content.append(details);
        const thought={details,body,label,spark,group,boundary:null};this.thoughts.push(thought);group.currentThink=thought;group.lastType='thinking';this.think=details;this.thinkBody=body;this.updateActivity();return body;
      },
      appendThinking(text,boundary){const body=this.ensureThink(),thought=this.thoughts.at(-1);if(boundary&&thought.boundary&&thought.boundary!==boundary&&body.textContent)body.textContent+='\n\n';body.textContent+=text;thought.boundary=boundary||thought.boundary;},
      ensureBubble(){
        if(this.lastKind==='text'&&this.bubble)return this.bubble;
        const bubble=document.createElement('div');bubble.className='bubble';wrap.append(bubble);this.lastKind='text';this.bubble=bubble;this.segmentText='';this.textBoundary=null;return bubble;
      },
      appendText(text,boundary){
        this.thinkDone();const previous=this.lastKind;const bubble=this.ensureBubble();const separate=Boolean(this.segmentText&&boundary&&this.textBoundary&&boundary!==this.textBoundary);
        if(separate){this.segmentText+='\n\n';this.text+='\n\n';}else if(previous!=='text'&&this.text)this.text+='\n\n';
        this.segmentText+=text;this.text+=text;this.textBoundary=boundary||this.textBoundary;renderStable(bubble,this.segmentText,renderText);
      },
      addTool(id,name,detail){
        if(id&&this.toolMap.has(id))return this.toolMap.get(id).details;
        this.thinkDone();const group=this.ensureProcess();group.thinking=false;
        if(group.lastType!=='tools'){group.currentTools=document.createElement('div');group.currentTools.className='tools';group.content.append(group.currentTools);}group.lastType='tools';this.tools=group.currentTools;
        const details=document.createElement('details');details.className='tool pending';const summary=document.createElement('summary');const status=document.createElement('span');status.className='status';const label=document.createElement('span');label.className='name';label.textContent=window.claudeToolName(name);const description=document.createElement('span');description.className='detail';description.textContent=detail||'';const chevron=document.createElement('span');chevron.className='chev';chevron.textContent='›';summary.append(status,label,description,chevron);details.append(summary);group.currentTools.append(details);
        const item={details,done:false,failed:false,unknown:false,group};if(id){this.toolMap.set(id,item);group.items.set(id,item);}this.updateActivity();return details;
      },
      toolResult(id,text,isError=false){
        const item=this.toolMap.get(id);if(!item)return;item.details.classList.remove('pending','unconfirmed');item.details.classList.toggle('failed',isError);let pre=item.details.querySelector('pre');if(!pre){pre=document.createElement('pre');item.details.append(pre);}pre.textContent=text||'（无输出）';item.done=true;item.failed=isError;item.unknown=false;this.updateActivity();
      },
      updateActivity(){
        for(const group of this.processes){
          const items=[...group.items.values()],pending=items.some(item=>!item.done&&!item.unknown),unknown=items.some(item=>item.unknown),failed=items.some(item=>item.failed),interrupted=group.terminal==='failed'||group.terminal==='interrupted';let label;
          // The round outcome leads: a missing tool result after the round ended
          // is a detail ("状态待同步"), never a replacement for "本轮已中断".
          if(group.thinking)label='正在思考';
          else if(interrupted&&unknown)label='本轮已中断 · 状态待同步';
          else if(unknown)label='状态待同步';
          else if(pending)label='执行中';
          else if(failed)label='部分失败';
          else if(interrupted)label='本轮已中断';
          else label=items.length?'已完成':'已思考';
          group.summary.textContent=label+(items.length?' · '+items.length+' 项操作':'');
        }
      },
      thinkDone(){for(const thought of this.thoughts){thought.spark.remove();thought.label.textContent='已思考';thought.group.thinking=false;}this.updateActivity();},
      finish(status='complete'){this.thinkDone();for(const group of this.processes){group.terminal=status;for(const item of group.items.values()){if(item.done)continue;item.unknown=true;item.details.classList.remove('pending');item.details.classList.add('unconfirmed');}}this.updateActivity();},
      removeIfEmpty(){if(!this.processes.length&&!this.text)wrap.remove();}
    };return owner;
  };
})();
