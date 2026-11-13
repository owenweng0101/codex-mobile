import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync, crc32} from 'node:zlib';
import {updateDesktopQr, QR_NAME, STATUS_NAME, RETIRED_QR_NAMES} from './update.mjs';

// Generated PNG pixels, not a QR carrying a runtime credential.
function fixturePng() {
  const chunk=(type,data)=>{const name=Buffer.from(type),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([size,name,data,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(16,0);header.writeUInt32BE(16,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc(16*(1+16*3));for(let y=0;y<16;y++)for(let x=0;x<48;x++)pixels[y*49+x+1]=(x*7+y*11)%256;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
const png=fixturePng(),data='data:image/png;base64,'+png.toString('base64');
const states=()=>({mobile:{status:'online'},dsh:{status:'online',upstreamReady:true},claude:{status:'online',upstreamReady:true,qr:data,phoneUrl:'https://fixture.example.test/m/?t='+'x'.repeat(43)}});
async function fixture(t) {
  const home=await mkdtemp(join(tmpdir(),'mobile-qr-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const directory=join(home,'Desktop','手机连接');await mkdir(directory,{recursive:true});return {home,directory};
}

test('online → offline → online keeps only the unified QR and status; never resurrects old codes', async t => {
  const {home,directory}=await fixture(t);
  for(const name of RETIRED_QR_NAMES)await writeFile(join(directory,name),'retired');
  await updateDesktopQr({home,getStatuses:async()=>states()});
  assert.deepEqual((await readdir(directory)).sort(),[QR_NAME,STATUS_NAME].sort());assert.deepEqual(await readFile(join(directory,QR_NAME)),png);
  for(const name of RETIRED_QR_NAMES)await writeFile(join(directory,name),'retired again');
  await updateDesktopQr({home,getStatuses:async()=>({...states(),claude:{status:'offline'}})});
  assert.deepEqual(await readdir(directory),[STATUS_NAME]);assert.match(await readFile(join(directory,STATUS_NAME),'utf8'),/暂不可用，等待自动恢复/);
  await updateDesktopQr({home,getStatuses:async()=>states()});
  assert.deepEqual((await readdir(directory)).sort(),[QR_NAME,STATUS_NAME].sort());
});

test('other tabs remain healthy while unified failure removes the stale unified image', async t => {
  const {home,directory}=await fixture(t);await updateDesktopQr({home,getStatuses:async()=>states()});
  const result=await updateDesktopQr({home,getStatuses:async()=>({...states(),claude:{status:'offline'}})});
  assert.equal(result.available,false);assert.deepEqual(await readdir(directory),[STATUS_NAME]);
  const text=await readFile(join(directory,STATUS_NAME),'utf8');assert.match(text,/Codex：连接已就绪/);assert.match(text,/DSH：聊天可用/);
  assert.doesNotMatch(text,/旧.*二维码|x{43}|phoneUrl|https?:/);
});

test('unchanged content keeps timestamps, remains private and leaves no temporary artifacts', async t => {
  const {home,directory}=await fixture(t);await updateDesktopQr({home,getStatuses:async()=>states()});
  const before=await stat(join(directory,QR_NAME));await updateDesktopQr({home,getStatuses:async()=>states()});
  assert.equal((await stat(join(directory,QR_NAME))).mtimeMs,before.mtimeMs);
  assert.equal((await stat(directory)).mode&0o777,0o700);
  for(const name of [QR_NAME,STATUS_NAME])assert.equal((await stat(join(directory,name))).mode&0o777,0o600);
  assert.ok((await readdir(directory)).every(name=>!name.endsWith('.tmp')));
});

test('invalid image or failed status read removes stale QR and still produces a useful status file', async t => {
  const {home,directory}=await fixture(t);
  for(const bad of [null,'not-png','data:image/png;base64,'+Buffer.alloc(128).toString('base64')]) {
    await writeFile(join(directory,QR_NAME),'stale');
    await updateDesktopQr({home,getStatuses:async()=>({...states(),claude:{status:'online',qr:bad}})});
    assert.deepEqual(await readdir(directory),[STATUS_NAME]);
  }
  await updateDesktopQr({home,getStatuses:async()=>{throw Error('private response details');}});
  assert.deepEqual(await readdir(directory),[STATUS_NAME]);assert.doesNotMatch(await readFile(join(directory,STATUS_NAME),'utf8'),/private response/);
});

test('LAN-only entry remains one unified QR; unavailable desktop Claude does not hide other tabs', async t => {
  const {home,directory}=await fixture(t);
  await updateDesktopQr({home,getStatuses:async()=>({...states(),claude:{status:'local',upstreamReady:false,qr:data}})});
  const text=await readFile(join(directory,STATUS_NAME),'utf8');assert.match(text,/仅同一局域网/);assert.match(text,/电脑端暂未就绪/);
  assert.deepEqual((await readdir(directory)).sort(),[QR_NAME,STATUS_NAME].sort());
});

test('migration preserves unrelated user files and never writes through an image symlink', async t => {
  const {home,directory}=await fixture(t),outside=join(home,'keep.txt');await writeFile(outside,'user data');
  await writeFile(join(directory,'notes.txt'),'keep notes');await symlink(outside,join(directory,QR_NAME));
  await updateDesktopQr({home,getStatuses:async()=>states()});
  assert.equal(await readFile(outside,'utf8'),'user data');assert.equal(await readFile(join(directory,'notes.txt'),'utf8'),'keep notes');
  assert.deepEqual(await readFile(join(directory,QR_NAME)),png);
});
