// Native Codex uses this built-in section identity, independent of its name.
export const PINNED_SECTION_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = () => Object.assign(new Error('Codex 原生置顶暂不可用，请稍后刷新重试'), { code:'NATIVE_PINS_UNAVAILABLE' });

// Groups and read markers remain local. Pins use the same native section as
// Desktop; a mobile-only success must never hide a failed native write.
export class NativeOrganization {
  constructor({core,local,onChanged=()=>{}}) {
    this.core=core;this.local=local;this.onChanged=onChanged;this.previous=null;
    this.readPending=null;this.migration=null;this.supported=false;this.writes=Promise.resolve();
  }
  call(method,params) { return this.core.call(method,params,5000); }
  async support() {
    if(this.supported)return;
    let cursor=null;const seen=new Set();
    for(let page=0;page<20;page++) {
      const result=await this.call('threadSection/list',{limit:100,...(cursor?{cursor}:{})});
      if(!Array.isArray(result.data))throw unavailable();
      if(result.data.some(section=>section.id===PINNED_SECTION_ID)){this.supported=true;return;}
      if(!result.nextCursor)break;
      if(seen.has(result.nextCursor))throw unavailable();seen.add(result.nextCursor);cursor=result.nextCursor;
    }
    throw unavailable();
  }
  refresh() {
    if(this.readPending)return this.readPending;
    const pending=this.readPins();this.readPending=pending;
    const done=()=>{if(this.readPending===pending)this.readPending=null;};pending.then(done,done);return pending;
  }
  async readPins() {
    await this.support();const pins=[],ids=new Set(),cursors=new Set();let cursor=null;
    for(let page=0;page<20;page++) {
      const result=await this.call('thread/list',{limit:100,sectionId:PINNED_SECTION_ID,sortKey:'section_position',modelProviders:[],useStateDbOnly:true,...(cursor?{cursor}:{})});
      if(!Array.isArray(result.data)||result.data.some(thread=>!UUID.test(thread.id||'')))throw unavailable();
      for(const thread of result.data)if(!ids.has(thread.id)){ids.add(thread.id);pins.push(thread.id);}
      if(!result.nextCursor){const changed=this.previous!==null&&JSON.stringify(this.previous)!==JSON.stringify(pins);this.previous=pins;if(changed)this.onChanged();return [...pins];}
      if(cursors.has(result.nextCursor))throw unavailable();cursors.add(result.nextCursor);cursor=result.nextCursor;
    }
    throw unavailable();
  }
  async setPin(threadId,enabled) {
    if(!UUID.test(threadId||'')||typeof enabled!=='boolean')throw new Error('置顶会话或状态无效');
    await this.support();const {thread}=await this.call('thread/read',{threadId,includeTurns:false});
    if(thread?.id!==threadId||!Object.hasOwn(thread,'section')||thread.archived===true)throw unavailable();
    const pinned=thread.section?.id===PINNED_SECTION_ID;
    // Unpinning a thread already in a custom section must preserve that section.
    if(pinned!==enabled) {
      await this.call('thread/section/move',{threadId,sectionId:enabled?PINNED_SECTION_ID:null});
      const check=await this.call('thread/read',{threadId,includeTurns:false});
      if(check.thread?.id!==threadId||!Object.hasOwn(check.thread,'section')||(check.thread.section?.id===PINNED_SECTION_ID)!==enabled)throw unavailable();
    }
  }
  migrate() {
    if(!this.migration)this.migration=(async()=>{
      // Retire each legacy mobile pin only after its native placement is proven.
      for(const threadId of this.local.get().pins||[]) {
        await this.setPin(threadId,true);
        await this.local.handle({action:'pin',threadId,enabled:false});
      }
    })().catch(error=>{this.migration=null;throw error;});
    return this.migration;
  }
  async get() { await this.migrate();return {...this.local.get(),pins:await this.refresh()}; }
  handle(data) {
    const operation=this.writes.catch(()=>{}).then(async()=>{
      await this.migrate();
      if(data.action==='pin')await this.setPin(data.threadId,data.enabled);
      else await this.local.handle(data);
      // Any pre-mutation read must finish before authoritative read-back.
      await this.readPending?.catch(()=>{});
      const result=await this.get();
      if(data.action==='pin'&&result.pins.includes(data.threadId)!==data.enabled)throw unavailable();
      return result;
    });this.writes=operation;return operation;
  }
}
