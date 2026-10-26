import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexReadClient} from '../api-client.mjs';
test('the history-window route is readonly and preserves explicit source fallback and epoch error codes',async()=>{
 const client=new CodexReadClient({fetchImpl:async url=>url.includes('sourceEpoch=old')?new Response(JSON.stringify({error:'changed',code:'HISTORY_WINDOW_CHANGED'}),{status:409}):new Response(JSON.stringify({error:'unsupported',code:'HISTORY_WINDOW_UNSUPPORTED'}),{status:501})});client.bearer='fixture';
 await assert.rejects(client.get('/api/history-window?threadId=fixture'),{code:'HISTORY_WINDOW_UNSUPPORTED',statusCode:501});
 await assert.rejects(client.get('/api/history-window?threadId=fixture&sourceEpoch=old'),{code:'HISTORY_WINDOW_CHANGED',statusCode:409});
 await assert.rejects(client.get('/api/history-window/elsewhere?threadId=fixture'));
});
test('only a process-owned explicit loopback origin can select an isolated native backend',async t=>{
 const previous=process.env.CODEX_MOBILE_BACKEND_ORIGIN;t.after(()=>{if(previous===undefined)delete process.env.CODEX_MOBILE_BACKEND_ORIGIN;else process.env.CODEX_MOBILE_BACKEND_ORIGIN=previous;});delete process.env.CODEX_MOBILE_BACKEND_ORIGIN;
 assert.throws(()=>new CodexReadClient({origin:'http://127.0.0.1:18887'}),/existing local Codex/);
 process.env.CODEX_MOBILE_BACKEND_ORIGIN='http://127.0.0.1:18887';const seen=[],client=new CodexReadClient({fetchImpl:async(url,options)=>{seen.push({url,options});return new Response(JSON.stringify(url.endsWith('/local/info')?{localUrl:'http://127.0.0.1:18887/#'+'x'.repeat(43)}:{rows:{window:[]}}));}});
 await client.get('/api/history-window?threadId=fixture');assert.equal(client.origin,'http://127.0.0.1:18887');assert.equal(seen[1].options.headers.authorization,'Bearer '+'x'.repeat(43));
 for(const configured of ['https://127.0.0.1:18887','http://localhost:18887','http://outside.invalid:18887','http://127.0.0.1:18887/private','http://127.0.0.1:18887/#secret']){process.env.CODEX_MOBILE_BACKEND_ORIGIN=configured;assert.throws(()=>new CodexReadClient(),/existing local Codex/);}
});
