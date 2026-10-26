from pathlib import Path
from urllib.parse import urljoin,urlsplit
from concurrent.futures import ThreadPoolExecutor
import re,subprocess,json,hashlib

root=Path(__file__).resolve().parent.parent/'vendor/zcode-web'
origin='https://zcode.z.ai';prefix='/remote/v4/3.16.3/'
pending=[];seen=set();added=[];failed=[]
pattern=re.compile(r'["\'`]((?:\.?\.?\/|\/remote\/|assets\/)?[A-Za-z0-9_./-]+-[A-Za-z0-9_-]{7,}\.(?:js|css|wasm|woff2?|ttf|svg|png|webp))["\'`]')
def discover(path):
    if path.suffix not in ['.js','.css','.html']:return
    text=path.read_text(errors='replace');url=origin+'/'+str(path.relative_to(root))
    for m in pattern.finditer(text):
        value=m[1];target=urljoin(origin+prefix if value.startswith('assets/') else url,value)
        if target.startswith(origin+prefix) and target not in seen:
            seen.add(target)
            if not (root/urlsplit(target).path.lstrip('/')).is_file():pending.append(target)
for path in list(root.rglob('*')):
    if path.is_file():discover(path)
def download(url):
    result=subprocess.run(['curl','-f','-sS','--connect-timeout','6','--max-time','20',url],capture_output=True)
    if result.returncode:return url,None
    path=root/urlsplit(url).path.lstrip('/');path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(result.stdout)
    return url,path
while pending:
    batch=pending[:10];pending=pending[10:]
    with ThreadPoolExecutor(max_workers=10) as pool:
        for url,path in pool.map(download,batch):
            if path is None:failed.append(urlsplit(url).path)
            else:added.append({'path':urlsplit(url).path,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()});discover(path)
    print(json.dumps({'added':len(added),'pending':len(pending),'failed':len(failed)}),flush=True)
Path(__file__).resolve().parent.joinpath('asset-followup-receipt.json').write_text(json.dumps({'added':added,'failed':failed,'originalSourcesModified':False},indent=2))
