// The pinned PDF.js build assumes APIs missing from older iOS WebViews.
// Install only missing methods, in both the lazy renderer and its owned Worker.
export function installPdfCompatibility() {
  const define = (target, name, value) => {
    if (typeof target[name] !== 'function') Object.defineProperty(target, name, {value, writable:true, configurable:true});
  };
  const iterator = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  if (typeof globalThis.Iterator === 'undefined') {
    const Iterator = function Iterator() { throw new TypeError('Iterator is abstract'); };
    Iterator.prototype = iterator;
    Object.defineProperty(globalThis, 'Iterator', {value:Iterator, writable:true, configurable:true});
  }
  define(iterator, 'toArray', function() { return Array.from(this); });
  define(iterator, 'some', function(callback) { let i=0; for(const value of this) if(callback(value,i++)) return true; return false; });
  define(iterator, 'find', function(callback) { let i=0; for(const value of this) if(callback(value,i++)) return value; });
  define(iterator, 'filter', function*(callback) { let i=0; for(const value of this) if(callback(value,i++)) yield value; });
  define(iterator, 'map', function*(callback) { let i=0; for(const value of this) yield callback(value,i++); });
  define(iterator, 'join', function(separator) { return Array.from(this).join(separator); });
  define(Promise, 'try', function(callback, ...args) { return new this(resolve => resolve(callback(...args))); });
  define(Promise, 'withResolvers', function() { let resolve,reject;const promise=new this((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; });
  for (const prototype of [Map.prototype, WeakMap.prototype]) {
    define(prototype, 'getOrInsert', function(key, value) { if(this.has(key))return this.get(key);this.set(key,value);return value; });
    define(prototype, 'getOrInsertComputed', function(key, callback) {
      if(typeof callback!=='function')throw new TypeError('Expected a callback');
      if(this.has(key))return this.get(key);
      const value=callback(key);this.set(key,value);return value;
    });
  }
  define(Uint8Array.prototype, 'toHex', function() { let text='';for(const byte of this)text+=byte.toString(16).padStart(2,'0');return text; });
  // Sum exact IEEE-754 values as integer multiples of the smallest subnormal,
  // then round once (ties to even), including finite intermediate overflow.
  define(Math, 'sumPrecise', function(values) {
    let total=0n,positive=false,negative=false,nan=false,negativeZero=true;
    const view=new DataView(new ArrayBuffer(8));
    for(const value of values){
      if(typeof value!=='number')throw new TypeError('Expected numbers');
      if(!Object.is(value,-0))negativeZero=false;
      if(Number.isNaN(value)){nan=true;continue;}
      if(value===Infinity){positive=true;continue;}if(value===-Infinity){negative=true;continue;}
      view.setFloat64(0,value);const bits=view.getBigUint64(0),exponent=Number((bits>>52n)&2047n);
      let units=bits&((1n<<52n)-1n);
      if(exponent)units=(units|(1n<<52n))<<BigInt(exponent-1);
      total+=(bits>>63n)?-units:units;
    }
    if(nan||(positive&&negative))return NaN;if(positive)return Infinity;if(negative)return -Infinity;
    if(total===0n)return negativeZero?-0:0;
    const sign=total<0n?-1:1,n=total<0n?-total:total,shift=Math.max(0,n.toString(2).length-53);
    let mantissa=n>>BigInt(shift);
    if(shift){const remainder=n-(mantissa<<BigInt(shift)),half=1n<<BigInt(shift-1);if(remainder>half||remainder===half&&(mantissa&1n))mantissa++;}
    return sign*Number(mantissa)*2**(shift-1074);
  });
  define(Set.prototype, 'intersection', function(other) { const result=new Set();for(const value of this.size<=other.size?this:other.keys())if((this.size<=other.size?other:this).has(value))result.add(value);return result; });
  define(RegExp, 'escape', function(text) {
    if(typeof text!=='string')throw new TypeError('Expected a string');
    let result='';
    for(let i=0;i<text.length;i++){
      const char=text[i],code=text.charCodeAt(i);
      if((i===0&&/[A-Za-z0-9]/.test(char))||",-=<>#&!%:;@~'`\" ".includes(char))result+='\\x'+code.toString(16).padStart(2,'0');
      else if('^$\\.*+?()[]{}|/'.includes(char))result+='\\'+char;
      else if(/\s/.test(char)||code>=0xd800&&code<=0xdfff)result+='\\u'+code.toString(16).padStart(4,'0');
      else result+=char;
    }
    return result;
  });
  define(Uint8Array.prototype, 'toBase64', function() {
    let text='';
    for(let i=0;i<this.length;i+=8192) text+=String.fromCharCode(...this.subarray(i,i+8192));
    return btoa(text);
  });
  define(Uint8Array, 'fromBase64', function(text) { return Uint8Array.from(atob(text), char => char.charCodeAt(0)); });
  if (typeof Response !== 'undefined') define(Response.prototype, 'bytes', async function() { return new Uint8Array(await this.arrayBuffer()); });
}

export function patchPdfCompatibility(source) {
  const factory = 'factory: (require) => {';
  const worker = 'new Blob([_dsh_pdf_worker_default,';
  if (source.split(factory).length !== 2 || source.split(worker).length !== 2) throw new Error('Pinned PDF runtime changed; review iOS compatibility');
  const shim = '('+installPdfCompatibility.toString()+')();\n';
  return source.replace(factory, factory+'\n'+shim).replace(worker, 'new Blob(['+JSON.stringify(shim)+', _dsh_pdf_worker_default,');
}
