import assert from 'node:assert/strict';
import {trackPendingHistoryScroll} from './scroll-anchor.mjs';
export function scrollAnchorEdits(source){
 const before='n!==`layout`&&(Re.current=!1),Ve.current=e.scrollTop,At(e),_t(Bbn({',after='n!==`layout`&&(Re.current=!1),__codexIsMobile()&&__codexTrackPendingAnchor(Ue.current,a,e.scrollTop,n,o),Ve.current=e.scrollTop,At(e),_t(Bbn({';
 assert.equal(source.split(before).length-1,1,'Pending history scroll boundary changed');const start=source.indexOf(before);
 // Prepend briefly changes measured height. Only real scroll events may resume
 // a paused follow state; layout must preserve the reader's current position.
 const layoutBefore='userScrollIntent:yt()})),Vbn(je.current,ke())',layoutAfter='userScrollIntent:__codexIsMobile()&&!je.current?`awayFromBottom`:yt()})),Vbn(je.current,ke())';
 assert.equal(source.split(layoutBefore).length-1,1,'Timeline layout follow boundary changed');const layoutStart=source.indexOf(layoutBefore);
 return[{start,end:start+before.length,text:after},{start:layoutStart,end:layoutStart+layoutBefore.length,text:layoutAfter},{start:source.length,end:source.length,text:'\nvar __codexTrackPendingAnchor='+trackPendingHistoryScroll.toString()+';\n'}];
}
