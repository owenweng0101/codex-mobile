// Client-only presentation state. Never dispatches or retries a native command.
export function createInlineInputState({now=Date.now,newId=()=>crypto.randomUUID(),nativeId=async(commandId,workspacePath)=>{
 const value=JSON.stringify({commandId,workspacePath}),bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
 return 'zcv4_'+[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,48);
}}={}){
 const records=new Map(),listeners=new Set(),aliases=new Map();let version=0;
 const changed=()=>{version++;for(const listener of listeners)listener();};
 const find=commandId=>[...records.values()].find(item=>item.commandId===commandId);
 const alias=(commandId,value)=>{if(value){aliases.set(commandId,value);while(aliases.size>512)aliases.delete(aliases.keys().next().value);}};
 const api={
  nativeIdFor(commandId){return aliases.get(commandId);},
  bindLedger(ledger,command){const value=aliases.get(command.commandId),entry=ledger.findCommand(command.commandId);if(value&&entry){entry.nativeInputId=value;ledger.commit();}},
  subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},version:()=>version,
  begin({sessionId,workspacePath,scopeId,text,attachments=[]}){if(records.size>=128)throw Error('仍有消息状态待确认，请先核对后再发送');const item={id:newId(),sessionId,workspacePath,scopeId,text,attachments:attachments.map(item=>({...item})),createdAt:now(),state:'sending'};records.set(item.id,item);changed();return item.id;},
  bind(id,commandId){const item=records.get(id);if(item){item.commandId=commandId;changed();}},
  async prepare(command,workspacePath){if(command.type!=='sendText')return;const item=find(command.commandId);if(!item)return;item.sessionId=command.sessionId;item.nativeInputId=await nativeId(command.commandId,workspacePath);alias(command.commandId,item.nativeInputId);changed();},
  ack(command,result){const item=find(command.commandId);if(!item)return;if(['accepted','duplicate'].includes(result.status)){item.nativeInputId=result.result?.inputId||item.nativeInputId;alias(command.commandId,item.nativeInputId);item.state=result.result?.delivery==='queue'?'waiting':'accepted';}else if(result.status!=='noop'){item.state=result.status==='unknown'?'unknown':'failed';item.error=result.message;}changed();},
  fail(id,error){const item=records.get(id);if(item){item.state=['accepted','waiting'].includes(item.state)||error?.outcomeUnknown||/UNKNOWN|TIMEOUT|CONNECTION|CLOSED/.test(error?.code||'')?'unknown':'failed';item.error=error?.message;changed();}},
  discard(id){if(records.delete(id))changed();},
  blocked(id){const item=records.get(id);if(!item)return;if(!item.commandId){records.delete(id);}else if(item.state!=='unknown'){item.state='failed';}changed();},
  reconcile(sessionId,rows){const ids=new Set(rows.filter(row=>row.kind==='userInput').map(row=>row.sourceCommandId).filter(Boolean));let removed=false;for(const [id,item]of records)if(item.sessionId===sessionId&&item.nativeInputId&&ids.has(item.nativeInputId)){records.delete(id);removed=true;}if(removed)changed();},
  project({sessionId,workspacePath,scopeId,rows=[],queue={items:[]}}){
   const ids=new Set(rows.filter(row=>row.kind==='userInput').map(row=>row.sourceCommandId).filter(Boolean));
   const own=[...records.values()].filter(item=>item.workspacePath===workspacePath&&(sessionId===null?item.scopeId===scopeId:item.sessionId===sessionId)&&!ids.has(item.nativeInputId));
   const items=[],represented=new Set();
   for(const queued of queue.items){if(ids.has(queued.sourceCommandId))continue;const item=own.find(item=>item.nativeInputId===queued.sourceCommandId);if(item)represented.add(item.id);items.push({...queued,queueItemId:item?.id||queued.queueItemId,sourceCommandId:item?.id||queued.sourceCommandId,__mobileOwnInput:!!item,__mobileState:item?.state==='failed'||item?.state==='unknown'?item.state:queue.pauseReason==='error'?'unknown':queue.autoDrain===false?'waiting':'sending'});}
   for(const item of own){if(represented.has(item.id))continue;items.push({queueItemId:item.id,sourceCommandId:item.id,clientId:'codex-mobile',kind:'sendText',text:item.text,attachments:item.attachments,admittedAt:item.createdAt,order:{admissionSeq:0},__mobileState:item.state,__mobileOwnInput:true});}
   items.sort((a,b)=>a.admittedAt-b.admittedAt);return{pendingGuides:items.map((item,index)=>({...item,order:{admissionSeq:index}})),visibleQueue:{...queue,items:[]}};
  }
 };return api;
}
export function inlineInputStatus(state,locale='zh-CN'){
 const zh=locale.startsWith('zh');return({sending:zh?'发送中…':'Sending…',accepted:zh?'已发送，等待同步…':'Sent, syncing…',waiting:zh?'等待发送…':'Waiting to send…',unknown:zh?'发送状态待确认，请核对后再操作':'Delivery unconfirmed; check before sending again',failed:zh?'发送失败，输入内容已保留':'Send failed; input preserved'})[state]||(zh?'发送中…':'Sending…');
}

export function inlineScrollKey(items=[]){return items.filter(item=>item.__mobileOwnInput).at(-1)?.queueItemId??null;}
