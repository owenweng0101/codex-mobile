export const messageBusy = () => Object.assign(new Error('该会话正在运行或有待发消息，本次消息尚未发送。'), { code:'SESSION_BUSY', statusCode:409, sent:false });

export function hasPendingDelivery(data, queue) {
  return queue.get(data.threadId).items.length > 0;
}

// Verify the selected native turn immediately before sending an interrupt.
// The desktop protocol also receives the expected ID and checks it atomically.
export async function interruptExpectedTurn(data, {snapshot, pauseQueue, interrupt}) {
  if(typeof data.expectedTurnId!=='string'||!data.expectedTurnId.trim()||typeof data.requestId!=='string'||!data.requestId.trim())throw Object.assign(new Error('缺少要停止的任务编号'),{statusCode:400,sent:false});
  const native=await snapshot(data.threadId);
  if(native.activeTurn!==data.expectedTurnId)return{accepted:false,stale:true,expectedTurnId:data.expectedTurnId};
  await pauseQueue(data.threadId);
  const result=await interrupt(data.threadId,data.expectedTurnId);
  if(result?.interruptedTurnId!==data.expectedTurnId)throw Object.assign(new Error('停止结果待核对，请查看当前会话'),{statusCode:409,outcomeUnknown:true});
  return{accepted:true,expectedTurnId:data.expectedTurnId};
}

// startNow is a strict delivery contract. It must never create a queue item;
// callers without this field retain the original local UI's implicit queue.
export async function deliverMessage(data, { receipt, prepare, isBusy, enqueue, dispatch }) {
  if (data.delivery !== undefined && data.delivery !== 'startNow') throw Object.assign(new Error('不支持的发送方式'), { code:'INVALID_DELIVERY', statusCode:400, sent:false });
  const previous = receipt(data);
  if (previous) return await previous;
  await prepare(data);
  if (isBusy(data)) {
    if (data.delivery === 'startNow') throw messageBusy();
    return { queued:true, ...await enqueue(data) };
  }
  return dispatch(data);
}
