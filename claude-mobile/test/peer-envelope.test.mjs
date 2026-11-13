import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTranscript} from '../backend/lib/sessions.mjs';

const historicalEnvelope=text=>'<cross-session-message encoded="1">\n'+text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')+'\n</cross-session-message>';

const footer="This came from another Claude session — not typed by your user, but very likely working on their behalf.";
for(const header of ['Another Claude session sent a message:','Another Claude session sent a message while you were working:']){
  test('historical compact peer message remains readable on phone: '+header,()=>{
    const body='保留正文 &amp; <文件>\n</cross-session-message>\n\nThis came from another Claude session\n末行';
    const content=header+'\n'+historicalEnvelope(body)+'\n\n'+footer;
    const record={type:'user',uuid:'same-message',origin:{kind:'peer',from:'unknown'},message:{content}};
    const result=parseTranscript(JSON.stringify(record),'same-session');
    assert.equal(result.messages.length,1);
    assert.equal(result.messages[0].id,'same-message');
    assert.equal(result.messages[0].text,body);
    assert.equal(result.messages[0].rawText,content,'model/source history is kept intact');
    assert.ok(content.endsWith(footer));
    assert.ok(historicalEnvelope(body).includes('&lt;/cross-session-message&gt;'));
    record.origin={kind:'human'};
    assert.equal(parseTranscript(JSON.stringify(record),'same-session').messages[0].text,content,'human text is never interpreted as a peer envelope');
  });
}
