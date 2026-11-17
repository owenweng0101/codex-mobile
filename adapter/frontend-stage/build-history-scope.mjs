import assert from 'node:assert/strict';

// The V4 wire API addresses rows by session, but this adapter deliberately gives
// each subscription its own epoch. Preserve that read authority through the real
// store -> transport wrapper -> RPC chain, without changing write revisions.
export const historyScopePatches=Object.freeze([
 {
  name:'store-older-page-epoch',
  before:'let r=t.rows.window[0]?.rowId;if(r!==void 0){this.setState({loadingOlder:!0});try{let t=await this.transport.rowsRange({sessionId:n,beforeRowId:r,limit:e})',
  after:'let r=t.rows.window[0]?.rowId;if(r!==void 0){const __codexOlderEpoch=t.logEpoch,__codexOlderSubscription=this.state.subscriptionId;this.setState({loadingOlder:!0});try{if(this.closed||this.state.subscriptionId!==__codexOlderSubscription||this.state.snapshot?.logEpoch!==__codexOlderEpoch||this.state.snapshot?.sessionId!==n||this.state.snapshot.rows.window[0]?.rowId!==r)return;let t=await this.transport.rowsRange({sessionId:n,beforeRowId:r,limit:e,baseLogEpoch:__codexOlderEpoch})',
 },
 {
  name:'store-complete-directory-epoch',
  before:'this.transport.rowsRange({sessionId:r,beforeRowId:c,limit:We.rowsRangeMaxLimit})',
  after:'this.transport.rowsRange({sessionId:r,beforeRowId:c,limit:We.rowsRangeMaxLimit,baseLogEpoch:a})',
 },
 {
  name:'native-rows-range-epoch-transport',
  before:'async rowsRange(t){return await a(),e.conversationRowsRangeV4({...n,sessionId:t.sessionId,...t.beforeRowId===void 0?{}:{beforeRowId:t.beforeRowId},limit:t.limit})}',
  after:'async rowsRange(t){return await a(),e.conversationRowsRangeV4({...n,sessionId:t.sessionId,...t.beforeRowId===void 0?{}:{beforeRowId:t.beforeRowId},limit:t.limit,...globalThis.__CODEX_ORIGINAL_BRIDGE__?.codexBridge===true&&t.baseLogEpoch!==void 0?{baseLogEpoch:t.baseLogEpoch}:{}})}',
 },
]);

export function historyScopeEdits(source){
 return historyScopePatches.map(({name,before,after})=>{
  assert.equal(source.split(before).length-1,1,'History scope patch boundary changed: '+name);
  const start=source.indexOf(before);return{start,end:start+before.length,text:after};
 });
}
