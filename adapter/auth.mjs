import {randomBytes,timingSafeEqual,createHmac} from 'node:crypto';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export class Pairing{
  constructor({token=randomBytes(32).toString('base64url'),now=Date.now,ttl=12*60*60*1000}={}){this.token=token;this.now=now;this.ttl=ttl;}
  mac(payload){
    // Domain separation prevents the persistent pairing secret from becoming a
    // browser credential. Derive from the current token so rotation revokes all
    // old cookies, including ones issued before this process restarted.
    const key=createHmac('sha256',this.token).update('codex-native-pair-cookie/key/v1').digest();
    return createHmac('sha256',key).update(payload).digest('base64url');
  }
  pair(token){
    if(!same(token,this.token))return null;
    const expires=Math.floor(this.now()+this.ttl);
    if(!Number.isSafeInteger(expires)||expires<=this.now())return null;
    const payload='v1.'+expires+'.'+randomBytes(24).toString('base64url');
    return payload+'.'+this.mac(payload);
  }
  allows(headers){
    if(typeof headers.cookie!=='string')return false;
    const values=headers.cookie.split(';').map(v=>v.trim()).filter(v=>v.startsWith('codex_native_pair='));
    if(values.length!==1)return false;
    const session=values[0].slice('codex_native_pair='.length),match=/^v1\.(0|[1-9]\d{0,15})\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/.exec(session);
    if(!match)return false;
    const expires=Number(match[1]);
    if(!Number.isSafeInteger(expires)||expires<=this.now())return false;
    return same(match[3],this.mac('v1.'+match[1]+'.'+match[2]));
  }
}
export function sameOrigin(headers,origin){return headers.host===new URL(origin).host&&(!headers.origin||headers.origin===origin)&&headers['sec-fetch-site']!=='cross-site';}
