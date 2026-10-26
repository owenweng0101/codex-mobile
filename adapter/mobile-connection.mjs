const connectionError = (message = '与电脑的连接已断开，正在重新连接') => Object.assign(new Error(message), {name:'ConnectionClosed',code:'CODEX_CONNECTION_CLOSED'});

// Each connection owns its requests. Reconnecting replaces services, never replays
// a command whose native outcome may already be committed.
export async function connectMobileServices({connect,url,onServices=()=>{},onState=()=>{},connectTimeoutMs=30000,readTimeoutMs=45000,writeTimeoutMs=160000,healthTimeoutMs=8000,retryDelayMs=500,maxRetryDelayMs=10000,environment=globalThis}={}){
 let current=null,pendingRecord=null,connecting=null,retryTimer=null,attempts=0,disposed=false,serial=0;
 const listeners=[];
 const emit=state=>{if(!disposed)onState(state);};
 const schedule=()=>{
  if(disposed||retryTimer||connecting||environment.document?.visibilityState==='hidden'||environment.navigator?.onLine===false)return;
  retryTimer=setTimeout(()=>{retryTimer=null;if(environment.document?.visibilityState==='hidden'||environment.navigator?.onLine===false)return;open().catch(()=>{});},Math.min(maxRetryDelayMs,retryDelayMs*2**Math.min(attempts++,5)));
 };
 function invalidate(record,error=connectionError()){
  if(record.closed)return;record.closed=true;
  for(const reject of [...record.pending])reject(error);
  record.pending.clear();record.socket?.close();
  if(current===record){current=null;emit('connecting');schedule();}
 }
 function wrap(record,raw){
  const result={...raw};
  for(const key of Object.keys(raw)){
   const service=raw[key];if(!service||typeof service!=='object')continue;
   result[key]=new Proxy(service,{get(target,method,receiver){
    const value=Reflect.get(target,method,receiver);if(typeof value!=='function'||typeof method!=='string')return value;
    // Event subscriptions retain the original event/disposal contract. A new
    // service identity lets the original UI release and recreate subscriptions.
    if(/^on[A-Z]/.test(method))return value.bind(target);
    return(...args)=>{
     if(record.closed)return Promise.reject(connectionError());
     const write=/^(send|create|set|update|mutate|archive|unarchive|delete|remove|start|stop|admit|commit|attachment(?:Begin|Chunk|Commit|Abort))/.test(method);
     let timer,rejectRequest;
     const lost=new Promise((_,reject)=>{rejectRequest=error=>reject(write?Object.assign(connectionError('连接中断，请核对发送结果后再操作'),{outcomeUnknown:true,cause:error}):error);record.pending.add(rejectRequest);});
     const timed=new Promise((_,reject)=>{timer=setTimeout(()=>{
      const error=Object.assign(new Error(write?'操作结果仍待确认，请核对后再操作':'读取超时，正在重新连接，请稍后重试'),{code:write?'CODEX_OPERATION_TIMEOUT':'CODEX_READ_TIMEOUT',...(write?{outcomeUnknown:true}:{})});
      reject(error);if(!write)invalidate(record,error);
     },write?writeTimeoutMs:readTimeoutMs);});
     return Promise.race([Promise.resolve().then(()=>value.apply(target,args)),lost,timed]).finally(()=>{clearTimeout(timer);record.pending.delete(rejectRequest);});
    };
   }});
  }
  return result;
 }
 function open(){
  if(disposed)return Promise.reject(connectionError());
  if(connecting)return connecting;
  const record={id:++serial,socket:null,closed:false,pending:new Set()},initial=current===null&&attempts===0;
  pendingRecord=record;
  emit('connecting');
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{invalidate(record);reject(connectionError('与电脑的连接超时，请重试'));},connectTimeoutMs);});
  connecting=Promise.race([Promise.resolve().then(()=>connect(url,{
   onCreateSocket:socket=>{record.socket=socket;if(disposed||record.closed)socket.close();},
   onOpenSocket:socket=>{record.socket=socket;if(disposed||record.closed)socket.close();},
   onClose:()=>invalidate(record),
  })),timeout]).then(raw=>{
   if(disposed||record.closed){record.socket?.close();throw connectionError();}
   record.raw=raw;record.services=wrap(record,raw);current=record;attempts=0;
   onServices(record.services);emit('paired');return record.services;
  }).catch(error=>{invalidate(record,error);if(!initial)emit('connecting');throw error;}).finally(()=>{clearTimeout(timer);if(pendingRecord===record)pendingRecord=null;connecting=null;if(!disposed&&!current)schedule();});
  return connecting;
 }
 let probing=null;
 async function resume(){
  if(disposed||environment.document?.visibilityState==='hidden'||environment.navigator?.onLine===false)return;
  if(!current){clearTimeout(retryTimer);retryTimer=null;open().catch(()=>{});return;}
  if(probing)return probing;
  const record=current;
  if(record.socket&&record.socket.readyState!==1){invalidate(record);return;}
  // A socket may still report OPEN after a mobile network switch. This read
  // verifies an actual round trip without touching drafts or sending commands.
  const read=record.raw.modelSelectionService?.getView;
  if(typeof read!=='function')return;
  let timer;
  probing=Promise.race([Promise.resolve().then(()=>read.call(record.raw.modelSelectionService)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(connectionError()),healthTimeoutMs);})]).catch(()=>invalidate(record)).finally(()=>{clearTimeout(timer);probing=null;});
  return probing;
 }
 function listen(target,event,fn){if(!target?.addEventListener)return;target.addEventListener(event,fn);listeners.push(()=>target.removeEventListener(event,fn));}
 const services=await open().catch(error=>{disposed=true;clearTimeout(retryTimer);throw error;});
 listen(environment,'online',resume);listen(environment,'pageshow',resume);listen(environment.document,'visibilitychange',resume);
 return{services,resume,reconnect(){if(current)invalidate(current);return resume();},dispose(){disposed=true;clearTimeout(retryTimer);for(const remove of listeners)remove();if(current)invalidate(current);if(pendingRecord)invalidate(pendingRecord);current=null;}};
}
