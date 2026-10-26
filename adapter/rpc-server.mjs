import {WebSocketServer} from 'ws';
import {Emitter,VSBuffer,SocketProtocol,ChannelServer,ProxyChannel} from './vendor/rpc.mjs';
import {sameOrigin} from './auth.mjs';

// This adapter has a fixed channel registry for each connection. Preserve the
// original framing/dispatch/error encoding, but reject absent capabilities now
// instead of treating them as services that may register later.
class FixedChannelServer extends ChannelServer{
  // The pinned open-source RPC predates the 3.16.3 web client's event-error
  // response (205). Reject a missing event without closing the whole socket.
  sendResponse(response){if(response.type===205)return this.send([205,response.id],response.data);return super.sendResponse(response);}
  onEventListen(request){
    try{return super.onEventListen(request);}
    catch(error){this.sendResponse({id:request.id,type:205,data:{name:error.name||'Error',message:String(error.message||error)}});}
  }
  collectPendingRequest(request){
    this.sendResponse({id:request.id,type:request.type===102?205:202,data:{name:'CodexAdapterUnsupported',message:'此 Codex 版本尚未接入 '+String(request.channelName).slice(0,100),code:'CODEX_ADAPTER_UNSUPPORTED'}});
  }
}

export function attachOriginalRpc(server,{pairing,origin,services,createConnection,onRequest=()=>{}}){
  const wss=new WebSocketServer({noServer:true,maxPayload:8*1024*1024});
  server.on('upgrade',(request,socket,head)=>{
    if(request.url!=='/ws'||request.headers.origin!==origin||!sameOrigin(request.headers,origin)||!pairing.allows(request.headers)){
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;
    }
    wss.handleUpgrade(request,socket,head,ws=>wss.emit('connection',ws));
  });
  wss.on('connection',ws=>{
    const binding=createConnection?createConnection():{services,dispose(){}};
    const data=new Emitter();
    const transport={onData:data.event,write:bytes=>{if(ws.readyState===1)ws.send(bytes.buffer);},drain:async()=>{}};
    const protocol=new SocketProtocol(transport),channels=new FixedChannelServer(protocol,{});
    ws.on('message',(raw,isBinary)=>{
      if(!isBinary){ws.close(1003,'Original binary RPC required');return;}
      try{data.fire(VSBuffer.wrap(new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength)));}catch{ws.close(1002,'Invalid RPC');}
    });
    ws.on('error',()=>{});
    ws.on('close',()=>{binding.dispose();channels.dispose();protocol.dispose();data.dispose();});
    for(const [channel,service] of Object.entries(binding.services)){
      const monitored=new Proxy(service,{get(target,method){
        const value=Reflect.get(target,method);
        if(typeof value!=='function'||typeof method!=='string'||/^on[A-Z]/.test(method))return value;
        return(...args)=>{
          const command=method==='sendConversationCommandV4'?args[0]?.envelope:null;
          const item={channel,method,argCount:args.length,...(command?{commandType:command.type,commandId:command.commandId,sessionId:command.sessionId,baseRevision:command.baseRevision,baseLogEpoch:command.baseLogEpoch,workspacePath:args[0]?.workspacePath,workspaceIdentity:args[0]?.workspaceIdentity,payloadKeys:Object.keys(command.payload||{}),configKeys:Object.keys(command.payload?.config||{}),followupMode:command.type==='setFollowupMode'?command.payload?.mode:undefined,selectedModel:String(command.payload?.config?.modelSelection?.modelId||command.payload?.modelSelection?.modelId||command.payload?.model||'').slice(0,200),selectedProvider:command.payload?.modelSelection?.providerId,selectedEffort:command.payload?.modelSelection?.options?.reasoningLevel,payloadMode:command.payload?.mode}: {})};
          onRequest(item);
          const failed=error=>{item.errorCode=error.code;item.error=String(error.message||error).slice(0,500);throw error;};
          try{const result=value.apply(target,args);return result&&typeof result.then==='function'?result.then(result=>{if(command)item.ackStatus=result?.status;return result;},failed):result;}catch(error){return failed(error);}
        };
      }});
      channels.registerChannel(channel,ProxyChannel.fromService(monitored));
    }
  });
  return()=>{for(const ws of wss.clients)ws.terminate();wss.close();};
}
