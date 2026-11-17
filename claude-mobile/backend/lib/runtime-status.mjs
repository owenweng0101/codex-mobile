const ms=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;

/** The clock is an observed native turn clock, never a page or request clock. */
export function nativeRuntimeObservation(value,now=Date.now()){
  if(!value||typeof value!=='object'||!['running','idle'].includes(value.status)||typeof value.turnId!=='string'||!value.turnId||value.turnId.length>256)return null;
  if(!ms(value.startedAt)||!ms(value.updatedAt)||value.startedAt>value.updatedAt||value.updatedAt>now+5000)return null;
  if(value.status==='running'&&(value.endedAt!==null||value.durationMs!==null))return null;
  if(value.status==='idle'&&(!ms(value.endedAt)||value.endedAt<value.startedAt||!ms(value.durationMs)))return null;
  return {status:value.status,turnId:value.turnId,startedAt:value.startedAt,endedAt:value.endedAt,durationMs:value.durationMs,updatedAt:value.updatedAt,...(typeof value.reason==='string'?{reason:value.reason.slice(0,80)}:{})};
}

export function runtimeStatus({attached=false,status=null,waitingFor=null,observation=null,now=Date.now()}={}){
  const known=Boolean(attached&&['busy','idle','waiting'].includes(status));
  const running=Boolean(known&&status==='busy');
  const waiting=Boolean(known&&waitingFor&&status!=='idle');
  const phase=!known?'unknown':waiting||status==='waiting'?'waiting':running?'running':'idle';
  const observed=nativeRuntimeObservation(observation,now);
  // Old completed/running turns cannot supply the clock of a new native phase.
  const clock=observed&&((running&&observed.status==='running')||(phase==='idle'&&observed.status==='idle'))?observed:null;
  return {phase,running,known,turnId:clock?.turnId??null,startedAtMs:clock?.startedAt??null,
    endedAtMs:clock?.endedAt??null,durationMs:clock?.durationMs??null,serverNowMs:now};
}
