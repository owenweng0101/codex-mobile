import assert from 'node:assert/strict';

// Labels describe actual transfer phases. In particular, receiving all bytes
// is not completion: attachmentCommitV4 must still return its saved receipt.
export function uploadPresentation(attachment) {
 const progress = Math.max(0, Math.min(100, Math.floor(Number(attachment.uploadProgress) || 0)));
 switch (attachment.uploadStatus) {
  case 'uploading': return {label:'上传中', value:progress+'%', progress, pending:false};
  case 'committing': return {label:'保存中', value:'', progress:0, pending:true};
  case 'ready': return {label:'已上传', value:'✓', progress:100, pending:false};
  case 'failed': return {label:'上传失败', value:'!', progress:0, pending:false};
  case 'queued': return {label:'等待上传', value:'', progress:0, pending:true};
  default: return {label:'准备上传', value:'', progress:0, pending:true};
 }
}

export function uploadProgressEdits(source) {
 const edits=[];
 function patch(name,needle,text) {
  assert.equal(source.split(needle).length-1,1,name);
  const start=source.indexOf(needle);edits.push({start,end:start+needle.length,text});
 }
 patch('upload-progress-presentation','var cu=384*1024;', uploadPresentation.toString()+';var cu=384*1024;');
 patch('image-upload-readable-size','className:n?`relative size-12 overflow-hidden rounded-lg bg-surface',
  'style:n?{width:64,height:64}:void 0,className:n?`relative size-12 overflow-hidden rounded-lg bg-surface');
 const start='d&&n?(0,$.jsxs)(`span`,{"data-testid":ax(cUe,e.id),role:e.uploadStatus===`failed`?`alert`:`status`';
 const from=source.indexOf(start),to=source.indexOf('):null]}),n?null:',from);
 assert(from>=0&&to>from,'image progress component bounds');
 const before=source.slice(from,to);
 const after='d&&n?(()=>{const p=uploadPresentation(e);return (0,$.jsxs)(`span`,{"data-testid":ax(cUe,e.id),"data-mobile-upload-progress":e.uploadStatus,role:e.uploadStatus===`failed`?`alert`:`status`,"aria-label":p.label+(p.value?` `+p.value:``),title:u,style:{position:`absolute`,inset:0,display:`flex`,flexDirection:`column`,alignItems:`center`,justifyContent:`center`,gap:1,background:`var(--background, #fff)`,color:`var(--foreground, #171717)`,fontSize:11,fontWeight:600,lineHeight:`13px`,pointerEvents:`none`},children:[(0,$.jsxs)(`svg`,{"aria-hidden":true,viewBox:`0 0 44 44`,style:{display:`block`,width:42,height:42,flexShrink:0},children:[(0,$.jsx)(`circle`,{cx:22,cy:22,r:18,fill:`none`,stroke:`currentColor`,opacity:.15,strokeWidth:3}),(0,$.jsx)(`circle`,{cx:22,cy:22,r:18,fill:`none`,stroke:`currentColor`,strokeWidth:3,pathLength:100,strokeDasharray:p.pending?`24 100`:`${p.progress} 100`,strokeLinecap:`round`,transform:`rotate(-90 22 22)`,children:p.pending?(0,$.jsx)(`animateTransform`,{attributeName:`transform`,type:`rotate`,from:`-90 22 22`,to:`270 22 22`,dur:`1s`,repeatCount:`indefinite`}):null}),(0,$.jsx)(`text`,{x:22,y:23,textAnchor:`middle`,dominantBaseline:`middle`,fill:`currentColor`,style:{fontSize:11,fontWeight:600},children:p.value})]}),(0,$.jsx)(`span`,{children:p.label})]})})(';
 // Keep the surrounding conditional and thumbnail children intact.
 patch('image-upload-visible-ring',before,after);
 return edits;
}
