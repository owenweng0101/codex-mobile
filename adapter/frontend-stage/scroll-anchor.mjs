// Keep the pending anchor in sync with reading performed while an older page is
// in flight. A positive prepend/measurement compensation is not a downward
// gesture; only explicit toward-bottom input may move that anchor downward.
export function trackPendingHistoryScroll(anchor,previousTop,nextTop,source,intent){
 if(!anchor||source!=='user'||!Number.isFinite(anchor.offsetTop)||!Number.isFinite(previousTop)||!Number.isFinite(nextTop))return;
 const delta=Math.max(0,nextTop)-Math.max(0,previousTop);
 if(delta<0||delta>0&&intent==='towardBottom')anchor.offsetTop-=delta;
}
