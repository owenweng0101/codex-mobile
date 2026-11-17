const UPDATE='mcp__ccd_turn__update_plan';
const WRAP='mcp__ccd_turn__wrap_up';
export const PLAN_TOOL_NAMES=new Set(['TodoWrite',UPDATE,WRAP]);
const state=value=>value==='completed'?'done':['done','in_progress','pending'].includes(value)?value:'pending';
const index=(value,length)=>Number.isSafeInteger(value)&&value>=1&&value<=length?value-1:-1;

export function applyPlanOperation(previous,name,input){
  if(!input||typeof input!=='object')return previous;
  const items=name==='TodoWrite'?input.todos:name===UPDATE?input.items:null;
  if(Array.isArray(items))return items.map(item=>({content:String(item?.content??''),status:state(item?.status)}));
  if(!Array.isArray(previous))return previous;
  const next=previous.map(item=>({...item}));
  if(name===WRAP)return next.map(item=>({...item,status:'done'}));
  if(name!==UPDATE)return previous;
  if(input.advance===true){
    const active=next.findIndex(item=>item.status==='in_progress');
    if(active>=0)next[active].status='done';
    const pending=next.findIndex(item=>item.status==='pending');
    if(pending>=0)next[pending].status='in_progress';
  }
  if(Array.isArray(input.done))for(const value of input.done){const at=index(value,next.length);if(at>=0)next[at].status='done';}
  if(Object.hasOwn(input,'start')){
    const at=index(input.start,next.length);
    if(at>=0){for(const item of next)if(item.status==='in_progress')item.status='pending';next[at].status='in_progress';}
  }
  return next;
}

/** Apply only successful, correlated native tool results, once per tool ID. */
export class NativePlanReducer{
  constructor(){this.plan=null;this.calls=new Map();this.applied=new Set();}
  call(id,name,input){if(typeof id==='string'&&PLAN_TOOL_NAMES.has(name)&&!this.calls.has(id))this.calls.set(id,{name,input});}
  result(id,{isError=false,content}={}){
    const call=this.calls.get(id);
    if(!call||this.applied.has(id))return;
    this.applied.add(id);
    if(isError)return;
    // MCP tools may return an error envelope without setting tool_result.is_error.
    if(Array.isArray(content)&&content.some(part=>part?.type==='text'&&/^(?:Error:|Tool (?:failed|denied)|Permission denied)/i.test(part.text??'')))return;
    this.plan=applyPlanOperation(this.plan,call.name,call.input);
  }
}
