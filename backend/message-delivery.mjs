export const messageBusy = () => Object.assign(new Error('该会话正在运行或有待发消息，本次消息尚未发送。'), { code:'SESSION_BUSY', statusCode:409, sent:false });

export function hasPendingDelivery(data, queue) {
  return data.delivery === 'startNow' ? queue.get(data.threadId).items.length > 0 : queue.hasPending(data.threadId);
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
