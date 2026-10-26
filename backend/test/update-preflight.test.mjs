import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareLocalUpdate, assertUpdatePermit, inspectLegacyService } from '../update-preflight.mjs';
const token = 'a'.repeat(43), drain = 'b'.repeat(48);
function server({ status = { ownedActive:{}, terminal:{ livePTYCount:0 } }, preparation = { ok:true, livePTYCount:0, token:drain, expiresAt:30000 }, maintenanceStatus = 200 } = {}) {
  const calls = [];
  return { calls, request:async (url, options = {}) => { const path=new URL(url).pathname; calls.push({ path, method:options.method || 'GET' }); const value=path==='/healthz'?{service:'codex-mobile-local'}:path==='/local/info'?{localUrl:'http://127.0.0.1:8787/#'+token}:path==='/api/status'?status:preparation; return { ok:path!=='/api/maintenance'||maintenanceStatus===200, json:async()=>value }; } };
}
test('update requires a fresh authoritative drain acknowledgment and sends no stop command', async () => {
  const mock=server(); const permit=await prepareLocalUpdate({request:mock.request,now:()=>1,inspectLegacy:()=>{throw Error('must not inspect fallback')}});
  assert.equal(permit.mode,'drained'); assertUpdatePermit(permit,29999); assert.throws(()=>assertUpdatePermit(permit,30000),/过期/);
  assert.deepEqual(mock.calls.map(c=>c.path),['/healthz','/local/info','/api/status','/api/maintenance']);
});
test('live model work or PTY prevents update before preparation', async () => {
  for(const status of [{ownedActive:{a:'turn'},terminal:{livePTYCount:0}},{ownedActive:{},terminal:{livePTYCount:1}}]){
    const mock=server({status}); await assert.rejects(prepareLocalUpdate({request:mock.request}),/正在运行|终端仍在运行/); assert.equal(mock.calls.some(c=>c.path==='/api/maintenance'),false);
  }
});
test('preparation races, malformed summary and missing runtime state fail closed', async () => {
  const race=server({maintenanceStatus:409,preparation:{error:'终端刚刚打开'}}); await assert.rejects(prepareLocalUpdate({request:race.request}),/刚刚打开/);
  const invalid=server({status:{ownedActive:{},terminal:{livePTYCount:'0'}}}); await assert.rejects(prepareLocalUpdate({request:invalid.request}),/无法核对/);
  const request=async()=>{throw Error('offline')}; await assert.rejects(prepareLocalUpdate({request,inspectLegacy:()=>({running:true})}),/无法核对/);
  assert.deepEqual(await prepareLocalUpdate({request,inspectLegacy:()=>({running:false})}),{mode:'offline'});
});
test('legacy transition only accepts an inspected process with no terminal or private creator', async () => {
  const allowed='  1 777 /usr/bin/ssh\n  2 777 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex\n';
  const executeFor=rows=>(command)=>command.endsWith('lsof')?'777\n':rows;
  assert.equal(inspectLegacyService({execute:executeFor(allowed)}).livePTYCount,0);
  for(const extra of ['  3 777 /usr/bin/python3\n','  3 777 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex\n'])assert.throws(()=>inspectLegacyService({execute:executeFor(allowed+extra)}),/未完成的子进程/);
  const mock=server({status:{ownedActive:{}}}); assert.equal((await prepareLocalUpdate({request:mock.request,inspectLegacy:()=>({running:true,pid:777,livePTYCount:0})})).mode,'legacy-verified');
});
