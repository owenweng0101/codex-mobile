import {marked} from 'marked';
// Resolve only explicit Markdown skill mentions against this workspace's native
// enabled catalog. Ordinary file links and unknown paths remain plain text.
export function skillInputs(text,catalog){
 if(typeof text!=='string'||!text.includes('[$'))return[];
 const known=new Map((catalog?.data||[]).filter(s=>s.enabled===true).map(s=>[s.path,s]));
 const found=new Map();
 marked.walkTokens(marked.lexer(text),token=>{
  if(token.type!=='link'||!token.text?.startsWith('$'))return;
  let path=token.href;try{path=decodeURIComponent(path)}catch{return}
  const skill=known.get(path);if(!skill||token.text!=='$'+skill.name)return;
  found.set(path,{type:'skill',name:skill.name,path:skill.path});
 });
 return [...found.values()];
}
