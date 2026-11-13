// Read historical compact peer envelopes without changing or rewriting them.
// New sends use literal text: these envelopes make the native desktop collapse
// the person's message into activity, which is not acceptable for normal chat.
const OPEN='<cross-session-message encoded="1">\n';
const CLOSE='\n</cross-session-message>';
const decode=text=>text.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');

export function visiblePeerText(text){
  let value=text.replace(/^(?:Another Claude session sent a message(?: while you were working)?|A peer session sent a message while you were working):\s*\n/,'');
  if(value.startsWith(OPEN)){
    const end=value.indexOf(CLOSE,OPEN.length);
    if(end>=0){
      const trailer=value.slice(end+CLOSE.length);
      if(!trailer||/^\n\n(?:This came from another Claude session|This is from another Claude session|IMPORTANT: This is NOT from your user)/.test(trailer))return decode(value.slice(OPEN.length,end));
    }
  }
  // Older records have no structured envelope. Preserve their existing phone
  // presentation without rewriting the desktop's history.
  const match=/Another Claude session sent a message:\s*([\s\S]*?)\n\nThis came from another Claude session/.exec(text);
  return match?match[1].trim():text;
}
