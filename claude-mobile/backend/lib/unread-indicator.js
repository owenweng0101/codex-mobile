/* Native unread state is authoritative. A read operation is scoped to one
 * desktop session and native store revision; retries reuse its operation ID. */
(() => {
  const operations=new Map(),MAX_CHECKS=3;
  const pendingKey=body=>'clm-native-read-pending-v1:'+JSON.stringify([body.sessionId,body.desktopSessionId]);
  function persist(operation){
    try{sessionStorage.setItem(pendingKey(operation.body),JSON.stringify({body:operation.body,checks:operation.checks,nativeFalseChecked:operation.nativeFalseChecked===true}));}catch{}
  }
  function forget(operation){
    try{if(JSON.parse(sessionStorage.getItem(pendingKey(operation.body))||'null')?.body?.requestId===operation.body.requestId)sessionStorage.removeItem(pendingKey(operation.body));}catch{}
  }
  function retire(operation){
    operation.awaiting=false;operation.retired=true;operation.status='superseded';
    clearTimeout(operation.checkTimer);operation.checkTimer=null;forget(operation);
  }
  function superseded(operation,marker){
    if(marker.unread!==true)return false;
    const old=operation.body.unreadVersion.split(':'),next=marker.unreadVersion?.split(':')||[];
    return old[0]!==next[0]||((old[1]==='manual'||next[1]==='manual')&&operation.body.unreadVersion!==marker.unreadVersion);
  }
  function restore(marker){
    try{
      const saved=JSON.parse(sessionStorage.getItem(pendingKey({sessionId:marker.id,desktopSessionId:marker.desktopSessionId}))||'null'),body=saved?.body;
      if(body?.sessionId!==marker.id||body?.desktopSessionId!==marker.desktopSessionId||typeof body.unreadVersion!=='string'||!body.unreadVersion||!/^[0-9a-f-]{36}$/i.test(body.requestId||''))return null;
      const operation={body,checks:Math.min(MAX_CHECKS,Math.max(0,Number(saved.checks)||0)),nativeFalseChecked:saved.nativeFalseChecked===true,awaiting:true,status:'awaiting',pending:null};
      operations.set(JSON.stringify([body.desktopSessionId,body.unreadVersion]),operation);return operation;
    }catch{return null;}
  }
  function pause(){for(const operation of operations.values()){clearTimeout(operation.checkTimer);operation.checkTimer=null;}}
  document.addEventListener?.('visibilitychange',()=>{if(document.hidden)pause();});
  window.addEventListener?.('pagehide',pause);
  const notify=(callback,...args)=>{try{Promise.resolve(callback?.(...args)).catch(()=>{});}catch{}};
  function requestId(marker,key){
    // Persist only operation identity, never a read receipt or an unread mask.
    // A reload after a lost response must query/retry the same server operation.
    const storageKey='clm-native-read-operation-v1:'+JSON.stringify([marker.id,key]);
    try{
      const saved=sessionStorage.getItem(storageKey);
      if(typeof saved==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved))return saved;
    }catch{}
    const id=crypto.randomUUID();
    try{sessionStorage.setItem(storageKey,id);}catch{}
    return id;
  }
  function pageVisible(){
    try{
      if(document.hidden)return false;
      let page=window;
      while(page.parent&&page.parent!==page){
        if(page.parent.document.hidden||!page.frameElement||page.frameElement.closest('[inert]')||!page.frameElement.getClientRects().length)return false;
        page=page.parent;
      }
      return true;
    }catch{return false;}
  }
  function visible(options){try{return pageVisible()&&options.isVisible?.()===true;}catch{return false;}}
  function loaded(marker,seenMessages,transcript,options){
    if(transcript?.id!==marker.id)return false;
    const reply=marker.replyUUID??marker.replyId;
    if(reply)return seenMessages?.has(reply)===true;
    // An empty delta is not evidence of an empty conversation.
    return options.fullHistory===true&&!transcript.truncated&&Array.isArray(transcript.messages)&&transcript.messages.length===0&&seenMessages?.size===0;
  }
  function reportPending(operation){
    operation.error=operation.checks>=MAX_CHECKS?'电脑端已读确认仍在等待，请点击重试。':'电脑端已收到已读请求，正在复核确认。';
    notify(operation.options.onStatus,operation.error,()=>run(operation));
  }
  function schedule(operation){
    if(operation.checkTimer||operation.status!=='awaiting')return;
    reportPending(operation);
    if(operation.checks>=MAX_CHECKS||!visible(operation.options))return;
    operation.checkTimer=setTimeout(()=>{
      operation.checkTimer=null;
      if(visible(operation.options))void run(operation,true).catch(()=>{});
    },1000*2**operation.checks);
  }
  async function run(operation,automatic=false){
    if(operation.pending)return operation.pending;
    if(operation.retired||!visible(operation.options))return false;
    clearTimeout(operation.checkTimer);operation.checkTimer=null;
    if(automatic){operation.checks++;persist(operation);}
    operation.status='pending';
    operation.pending=(async()=>{
      let timer;
      const controller=new AbortController();
      try{
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('原生已读同步超时，结果尚未确认。'));},30000);});
        const {response,result}=await Promise.race([(async()=>{
          const response=await fetch('/claude/api/read',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(operation.body),signal:controller.signal});
          return {response,result:await response.json()};
        })(),timeout]);
        if(operation.retired)return false;
        for(const field of ['requestId','sessionId','desktopSessionId']){
          if(result?.[field]!==undefined&&result[field]!==operation.body[field])throw Error('原生已读回执与当前会话不匹配。');
        }
        if(response.status===202&&result?.pending===true&&result.verified===false){
          operation.awaiting=true;operation.status='awaiting';persist(operation);
          return false;
        }
        if(!response.ok||(response.status!==undefined&&response.status!==200)||result?.ok!==true||result.verified!==true||result.unread!==false)throw Object.assign(Error(result?.error||'原生已读状态尚未确认。'),{code:result?.code});
        operation.status='verified';operation.awaiting=false;
        forget(operation);
        notify(operation.options.onStatus,null);
        notify(operation.options.onVerified,result);
        return true;
      }catch(error){
        if(operation.retired)return false;
        if(['READ_REPLY_CHANGED','READ_STATE_CHANGED'].includes(error?.code))retire(operation);
        operation.status='error';operation.error=error?.message||'原生已读同步失败，结果尚未确认。';
        notify(operation.options.onStatus,operation.error,()=>run(operation));
        return false;
      }finally{clearTimeout(timer);operation.pending=null;if(operation.status==='awaiting')schedule(operation);}
    })();
    return operation.pending;
  }
  window.claudeUnread={
    pause,
    isUnread(session){return session?.unread===true;},
    acknowledge(marker,seenMessages,transcript,options={}){
      try{
        if(!marker?.id||!visible(options))return Promise.resolve(false);
        if(marker.known!==true){
          notify(options.onStatus,'原生未读状态暂时无法确认。',options.refresh);
          return Promise.resolve(false);
        }
        // A false marker is native truth, but not a durable server receipt.
        // Finish any dispatched operation using its original immutable body.
        let outstanding=[...operations.values()].find(operation=>operation.awaiting&&operation.body.sessionId===marker.id&&operation.body.desktopSessionId===marker.desktopSessionId)||restore(marker);
        if(outstanding&&superseded(outstanding,marker)){retire(outstanding);outstanding=null;}
        if(outstanding){
          outstanding.options=options;
          if(outstanding.pending)return outstanding.pending;
          if(marker.unread===false&&!outstanding.nativeFalseChecked){
            outstanding.nativeFalseChecked=true;persist(outstanding);return run(outstanding);
          }
          if(outstanding.status==='awaiting')schedule(outstanding);
          else notify(options.onStatus,outstanding.error,()=>run(outstanding));
          return Promise.resolve(false);
        }
        if(marker.unread===false){notify(options.onStatus,null);return Promise.resolve(false);}
        if(marker.unread!==true||!marker.desktopSessionId||typeof marker.unreadVersion!=='string'||!marker.unreadVersion||!loaded(marker,seenMessages,transcript,options))return Promise.resolve(false);
        const key=JSON.stringify([marker.desktopSessionId,marker.unreadVersion]);
        let operation=operations.get(key);
        if(operation){
          // A CLI resume may change IDs. Never retarget an existing operation.
          if(operation.body.sessionId!==marker.id)return Promise.resolve(false);
          if(operation.retired)return Promise.resolve(false);
          operation.options=options;
          if(operation.pending)return operation.pending;
          if(operation.status==='verified'){notify(options.onStatus,null);return Promise.resolve(true);}
          // Polls do not automatically repeat a failed native resume.
          notify(options.onStatus,operation.error,()=>run(operation));
          return Promise.resolve(false);
        }
        operation={body:{requestId:requestId(marker,key),sessionId:marker.id,desktopSessionId:marker.desktopSessionId,unreadVersion:marker.unreadVersion},options,status:'pending',pending:null,checks:0};
        operations.set(key,operation);
        return run(operation);
      }catch(error){
        notify(options.onStatus,error?.message||'原生已读同步失败。',options.refresh);
        return Promise.resolve(false);
      }
    }
  };
})();
