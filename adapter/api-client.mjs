const allowed=new Set(['/api/file','/api/skills','/api/projects','/api/threads','/api/history','/api/models','/api/status','/api/events','/api/organize','/api/goal','/api/archived','/api/archived/history','/api/thread/archive/status']);

// The existing Mac service owns its bearer. It is never sent to the web client.
export class CodexReadClient{
  constructor({origin='http://127.0.0.1:8787',fetchImpl=fetch}={}){
    const parsed=new URL(origin);
    if(parsed.origin!=='http://127.0.0.1:8787')throw Error('Only the existing local Codex service is allowed');
    this.origin=parsed.origin;this.fetch=fetchImpl;this.bearer=null;this.requests=0;
  }
  async credentials(){
    const response=await this.fetch(this.origin+'/local/info',{redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Error('本机 Codex 服务尚未就绪');
    const info=await response.json(),url=new URL(info.localUrl);
    if(url.origin!==this.origin||!/^#[A-Za-z0-9_-]{32,128}$/.test(url.hash))throw Error('本机 Codex 配对信息无效');
    this.bearer=url.hash.slice(1);
  }
  async get(path,{signal}={}){
    if(typeof path!=='string'||path.length>12000||!path.startsWith('/api/')||path.includes('#'))throw Error('只允许明确的 Codex 读取接口');
    const target=new URL(path,this.origin);
    if(target.origin!==this.origin||!allowed.has(target.pathname))throw Error('此适配版本尚未开放该接口');
    if(!this.bearer)await this.credentials();
    for(let attempt=0;attempt<2;attempt++){
      this.requests++;
      const response=await this.fetch(target.href,{headers:{authorization:'Bearer '+this.bearer},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(target.pathname==='/api/events'?25000:20000)]):AbortSignal.timeout(target.pathname==='/api/events'?25000:20000)});
      if(response.status===401&&attempt===0){await this.credentials();continue;}
      const value=await response.json();
      if(!response.ok)throw Object.assign(Error(value.error||'Codex 读取失败'),{code:'CODEX_READ_FAILED',statusCode:response.status});
      return value;
    }
  }
  async getMedia(path,{maxBytes=8*1024*1024}={}){
    const target=new URL(path,this.origin);
    if(!path.startsWith('/api/file-content?')||target.origin!==this.origin||target.pathname!=='/api/file-content'||target.hash||target.searchParams.has('download'))throw Error('只允许工作区媒体预览');
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>8*1024*1024)throw Error('媒体预览大小无效');
    if(!this.bearer)await this.credentials();
    for(let attempt=0;attempt<2;attempt++){
      this.requests++;
      const response=await this.fetch(target.href,{headers:{authorization:'Bearer '+this.bearer},redirect:'error',signal:AbortSignal.timeout(20000)});
      if(response.status===401&&attempt===0){await response.body?.cancel();await this.credentials();continue;}
      if(!response.ok){const value=await response.json();throw Object.assign(Error(value.error||'媒体读取失败'),{code:'CODEX_READ_FAILED',statusCode:response.status});}
      if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();throw Error('图片超过手机预览大小限制');}
      const chunks=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw Error('图片超过手机预览大小限制');chunks.push(chunk);}
      return{bytes:Buffer.concat(chunks),mediaType:response.headers.get('content-type')?.split(';')[0]};
    }
  }
}
