import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseUrl,parseFormats,validateFile,parseReport,requestJson,ApiError } from '../frontend/core.js';
import { sampleIssues,sampleClean } from '../frontend/samples.js';
const formats={supported_mime_types:['application/pdf','text/html'],max_file_size_mb:10};
test('deployment URLs require HTTPS; loopback remains available for development',()=>{
  assert.equal(normalizeBaseUrl('https://example.edu/api/'),'https://example.edu/api');
  assert.equal(normalizeBaseUrl('http://localhost:8000'),'http://localhost:8000');
  for(const bad of ['http://example.edu','javascript:alert(1)','https://u:p@example.edu','https://example.edu?q=1'])assert.throws(()=>normalizeBaseUrl(bad),ApiError);
});
test('format discovery requires usable MIME data and a numeric limit',()=>{
  assert.deepEqual(parseFormats(formats),formats);
  for(const bad of [{},{supported_mime_types:[],max_file_size_mb:10},{supported_mime_types:['.pdf'],max_file_size_mb:10},{...formats,max_file_size_mb:'10'},{...formats,max_file_size_mb:9.99}])assert.throws(()=>parseFormats(bad),ApiError);
});
test('uploads use discovered types, binary MB boundary and browser MIME fallback',()=>{
  assert.doesNotThrow(()=>validateFile({name:'paper.pdf',type:'',size:10*1024*1024},formats));
  for(const [file,code] of [[null,'MISSING_FILE'],[{name:'paper.pdf',size:0},'UNPROCESSABLE_FILE'],[{name:'paper.pdf',size:10*1024*1024+1},'FILE_TOO_LARGE'],[{name:'notes.exe',size:2,type:'application/octet-stream'},'UNSUPPORTED_MEDIA_TYPE']])assert.throws(()=>validateFile(file,formats),e=>e.code===code);
});
test('complete findings and no-issue reports are accepted; partial reports are never successful',()=>{
  assert.equal(parseReport(sampleIssues).issues.length,3);assert.equal(parseReport(sampleClean).issues.length,0);
  for(const bad of [{},{issues:[]},{issues:[],message:''},{issues:[],message:42},{error:{message:'Failure'},issues:[]},{issues:[{...sampleIssues.issues[0],suggested_fix:''}]},{issues:[{...sampleIssues.issues[0],wcag_criterion:['1.1.1']}]},{issues:[{...sampleIssues.issues[0],location:'page 2'}]},{issues:[{...sampleIssues.issues[0],location:{page:-1}}]}])assert.throws(()=>parseReport(bad),ApiError);
});
test('multipart upload keeps the file field and wcag_level without a forced Content-Type',async()=>{
  const body=new FormData();body.append('file',new Blob(['sample']),'sample.html');body.append('wcag_level','AA');
  const result=await requestJson('https://service.edu','/analyze',{method:'POST',body,fetchImpl:async(url,opts)=>{
    assert.equal(url,'https://service.edu/analyze');assert.equal(opts.body.get('wcag_level'),'AA');assert.equal(opts.body.get('file').name,'sample.html');assert.equal(opts.headers,undefined);assert.equal(opts.credentials,'omit');return new Response(JSON.stringify(sampleClean));
  }});assert.deepEqual(result,sampleClean);
});
test('HTTP errors preserve structured error codes and do not become findings',async()=>{
  for(const status of [400,413,415,422,503])await assert.rejects(requestJson('','/analyze',{fetchImpl:async()=>new Response(JSON.stringify({error:{code:'TEST_ERROR',message:'Expected failure'}}),{status})}),e=>e.code==='TEST_ERROR' && e.status===status);
  await assert.rejects(requestJson('','/analyze',{fetchImpl:async()=>new Response('<html>bad gateway</html>',{status:503})}),e=>e.code==='INVALID_RESPONSE');
  await assert.rejects(requestJson('','/analyze',{fetchImpl:async()=>new Response(JSON.stringify({status:'processing'}),{status:202})}),e=>e.code==='PROCESSING_PENDING');
});
test('timeout and cancellation prevent success and have different errors',async()=>{
  const blockedFetch=async(url,{signal})=>new Promise((resolve,reject)=>{if(signal.aborted)reject(new DOMException('Aborted','AbortError'));else signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
  await assert.rejects(requestJson('','/analyze',{timeoutMs:10,fetchImpl:blockedFetch}),e=>e.code==='REQUEST_TIMEOUT');
  const c=new AbortController();const pending=requestJson('','/analyze',{signal:c.signal,fetchImpl:blockedFetch});c.abort();await assert.rejects(pending,e=>e.code==='REQUEST_CANCELED');
});
