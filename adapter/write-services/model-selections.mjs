import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';

// A phone's per-conversation choice is applied to its next native turn. It
// does not change the desktop's global model/provider configuration.
export class ModelSelections{
 constructor(directory){this.directory=directory;this.file=join(directory,'mobile-model-selections.json');this.values={};this.pending=Promise.resolve();this.ready=readFile(this.file,'utf8').then(text=>{this.values=JSON.parse(text);}).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 key(workspacePath,sessionId){return JSON.stringify([workspacePath,sessionId]);}
 async get(workspacePath,sessionId){await this.ready;return this.values[this.key(workspacePath,sessionId)]||null;}
 set(workspacePath,sessionId,value){
  const operation=this.pending.then(async()=>{await this.ready;await mkdir(this.directory,{recursive:true,mode:0o700});const next={...this.values,[this.key(workspacePath,sessionId)]:value},temp=this.file+'.tmp';await writeFile(temp,JSON.stringify(next),{mode:0o600});await rename(temp,this.file);this.values=next;return value;});
  this.pending=operation.catch(()=>{});return operation;
 }
}
