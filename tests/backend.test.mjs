import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';

let server, base;
test.before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => new Promise(resolve => server.close(resolve)));

async function upload(content, {type = 'text/html', name = 'document.html', level = 'AA'} = {}) {
  const form = new FormData();
  form.append('file', new Blob([content], {type}), name);
  form.append('wcag_level', level);
  return fetch(`${base}/analyze`, {method:'POST', body:form});
}

test('health, formats, static UI, and CORS form a runnable local service', async () => {
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), {status:'ok'});
  assert.deepEqual(await (await fetch(`${base}/formats`)).json(), {supported_mime_types:['text/html','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain'],max_file_size_mb:10});
  const ui = await fetch(`${base}/`); assert.equal(ui.status, 200); assert.match(await ui.text(), /ECE 30861 Group ADA Project/);
  const cors = await fetch(`${base}/formats`, {headers:{Origin:'http://127.0.0.1:3086'}}); assert.equal(cors.headers.get('access-control-allow-origin'),'http://127.0.0.1:3086');
});

test('HTML upload becomes a complete WCAG report and honors the requested level', async () => {
  const html = '<!doctype html><html lang="en"><head><title>Course page</title></head><body><h1>Course</h1><img src="chart.png"><a href="/x">click here</a></body></html>';
  const response = await upload(html); assert.equal(response.status, 200);
  const report = await response.json(); assert.deepEqual(report.issues.map(issue => issue.wcag_criterion), ['1.1.1','2.4.4']);
  const aa = await upload('<!doctype html><html lang="en"><title>T</title><p style="color:#949494">Low contrast</p></html>');
  assert.ok((await aa.json()).issues.some(issue => issue.wcag_criterion === '1.4.3'));
  const a = await upload('<!doctype html><html lang="en"><title>T</title><p style="color:#949494">Low contrast</p></html>', {level:'A'});
  assert.equal((await a.json()).issues.length, 0);
});

test('upload boundary errors are stable JSON and never return a report', async () => {
  const missing = await fetch(`${base}/analyze`, {method:'POST', body:new FormData()}); assert.equal(missing.status,400); assert.equal((await missing.json()).code,'MISSING_FILE');
  for (const [content, options, status, code] of [
    ['', {}, 422, 'UNPROCESSABLE_FILE'],
    ['plain text', {}, 422, 'UNPROCESSABLE_FILE'],
    ['PK', {type:'application/zip',name:'slides.zip'}, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['<html></html>', {type:'application/pdf',name:'paper.pdf'}, 422, 'UNPROCESSABLE_FILE'],
    ['<!doctype html><html></html>', {level:'AAA'}, 400, 'INVALID_WCAG_LEVEL'],
  ]) { const response = await upload(content,options); assert.equal(response.status,status); const body = await response.json(); assert.equal(body.code,code); assert.equal(body.issues,undefined); }
});
