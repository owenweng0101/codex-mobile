import test from 'node:test';import assert from 'node:assert/strict';import {createFileReadService} from '../read-services/files.mjs';
test('PDF preview returns exact byte ranges and rejects scope/type mismatches',async()=>{
 const bytes=Buffer.from('%PDF-1.7\nexact-range-fixture');let calls=0,type='application/pdf';
 const file=createFileReadService({baseServices:{project:{async readTree(){return{projects:[],tasks:[{workspacePath:'/accepted'}]};}}},api:{async getMedia(path){calls++;assert.match(path,/path=sample.pdf/);return{bytes,mediaType:type};}}});
 assert.deepEqual(await file.readFileRange({path:'/accepted/sample.pdf',offset:5,length:7}),new Uint8Array(bytes.subarray(5,12)));
 assert.equal((await file.readFileRange({path:'/accepted/sample.pdf',offset:bytes.length,length:10})).length,0);
 await assert.rejects(file.readFileRange({path:'/other/sample.pdf',offset:0,length:10}),/工作目录以外/);
 await assert.rejects(file.readFileRange({path:'/accepted/sample.txt',offset:0,length:10}),/PDF/);
 await assert.rejects(file.readFileRange({path:'/accepted/sample.pdf',offset:-1,length:10}),/范围/);
 assert.equal(calls,2);type='image/png';await assert.rejects(file.readFileRange({path:'/accepted/sample.pdf',offset:0,length:10}),/类型不匹配/);
});
