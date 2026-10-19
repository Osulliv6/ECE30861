// End-to-end: upload -> server -> Python parser -> engine -> report, plus server edge cases.
// Needs the parser's Python environment (accessibility-parser/.venv, or PYTHON=...).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from '../server.mjs';
import { parseReport } from '../frontend/core.js';

const fixture = name => readFile(new URL(`./fixtures/documents/${name}`, import.meta.url));
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const servers = [];
let tmpRoot, scratch;

async function start(options) {
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function upload(base, content, {type, name, level = 'AA'}) {
  const form = new FormData();
  form.append('file', new Blob([content], type ? {type} : {}), name);
  form.append('wcag_level', level);
  return fetch(`${base}/analyze`, {method:'POST', body:form});
}
const criteria = report => report.issues.map(issue => issue.wcag_criterion);
let base;

test.before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'ada-test-uploads-'));
  scratch = await mkdtemp(join(tmpdir(), 'ada-test-scratch-'));
  base = await start({parserOptions:{tmpRoot}});
});
test.after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await rm(tmpRoot, {recursive:true, force:true});
  await rm(scratch, {recursive:true, force:true});
});

test('DOCX upload produces findings for missing alt text, skipped heading, link text, and table headers', async () => {
  const response = await upload(base, await fixture('course.docx'), {type:DOCX, name:'course.docx'});
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(parseReport(report), report);
  assert.deepEqual(criteria(report), ['1.3.1','1.1.1','1.3.1','2.4.4']);
  assert.match(report.issues[0].description, /skip from 1 to 3/);
  assert.equal(report.issues[1].location.snippet, 'Picture 1');
});

test('PDF upload checks links but never reports unknown PDF alt text or headings as missing', async () => {
  const report = await (await upload(base, await fixture('course.pdf'), {type:'application/pdf', name:'course.pdf'})).json();
  assert.equal(parseReport(report), report);
  assert.deepEqual(criteria(report), ['2.4.4']);
  assert.deepEqual(report.issues[0].location, {page:1, snippet:'click here'});
});

test('plain text has no title or language to be missing, so a clean file gets the no-issue report', async () => {
  const report = await (await upload(base, await fixture('notes.txt'), {type:'text/plain', name:'notes.txt'})).json();
  assert.equal(parseReport(report), report);
  assert.deepEqual(report.issues, []);
  assert.match(report.message, /does not certify/);
});

test('missing or generic browser MIME types fall back to the file extension', async () => {
  const response = await upload(base, await fixture('course.docx'), {type:'application/octet-stream', name:'course.docx'});
  assert.equal(response.status, 200);
  assert.ok(criteria(await response.json()).includes('1.1.1'));
});

test('corrupt, encrypted, mismatched, and non-UTF-8 documents return 422 without a report', async () => {
  for (const [content, options] of [
    [await fixture('corrupt.docx'), {type:DOCX, name:'corrupt.docx'}],
    [await fixture('encrypted.pdf'), {type:'application/pdf', name:'encrypted.pdf'}],
    [await fixture('notes.txt'), {type:'application/pdf', name:'notes.pdf'}],
    [Buffer.from([0x3c,0x68,0x74,0x6d,0x6c,0x3e,0xff,0xfe]), {type:'text/html', name:'bad.html'}],
  ]) {
    const response = await upload(base, content, options);
    assert.equal(response.status, 422, options.name);
    const body = await response.json();
    assert.equal(body.code, 'UNPROCESSABLE_FILE');
    assert.equal(body.issues, undefined);
  }
});

test('uploaded files are deleted after both successful and failed analysis', async () => {
  await upload(base, await fixture('course.docx'), {type:DOCX, name:'course.docx'});
  await upload(base, await fixture('corrupt.docx'), {type:DOCX, name:'corrupt.docx'});
  assert.deepEqual(await readdir(tmpRoot), []);
});

test('a missing or hung parser returns 503 instead of crashing or hanging', async () => {
  const missing = await start({parserOptions:{python:'/nonexistent/python3', tmpRoot}});
  let response = await upload(missing, await fixture('notes.txt'), {type:'text/plain', name:'notes.txt'});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'PROCESSING_UNAVAILABLE');

  const hang = join(scratch, 'hang.sh');
  await writeFile(hang, '#!/bin/sh\nsleep 5\n');
  await chmod(hang, 0o755);
  const slow = await start({parserOptions:{python:hang, timeoutMs:200, tmpRoot}});
  response = await upload(slow, await fixture('notes.txt'), {type:'text/plain', name:'notes.txt'});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'PROCESSING_TIMEOUT');
  assert.deepEqual(await readdir(tmpRoot), []);
});

test('oversized and malformed uploads are rejected with stable JSON errors', async () => {
  const atLimit = await upload(base, Buffer.alloc(10*1024*1024, 0x61), {type:'text/plain', name:'at-limit.txt'});
  assert.equal(atLimit.status, 200);
  const big = await upload(base, Buffer.alloc(10*1024*1024+1, 0x61), {type:'text/plain', name:'big.txt'});
  assert.equal(big.status, 413);
  assert.equal((await big.json()).code, 'FILE_TOO_LARGE');
  const chunked = Readable.toWeb(Readable.from([Buffer.alloc(10*1024*1024+16_385, 0x61)]));
  const streamed = await fetch(`${base}/analyze`, {method:'POST', headers:{'Content-Type':'multipart/form-data; boundary=oversized'}, body:chunked, duplex:'half'});
  assert.equal(streamed.status, 413);
  assert.equal((await streamed.json()).code, 'FILE_TOO_LARGE');
  const noBoundary = await fetch(`${base}/analyze`, {method:'POST', headers:{'Content-Type':'multipart/form-data'}, body:'x'});
  assert.equal(noBoundary.status, 400);
  assert.equal((await noBoundary.json()).code, 'MALFORMED_REQUEST');
  const notMultipart = await fetch(`${base}/analyze`, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
  assert.equal(notMultipart.status, 400);
});

test('CORS allows only configured origins and answers preflight requests', async () => {
  const other = await fetch(`${base}/formats`, {headers:{Origin:'https://evil.example'}});
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  const preflight = await fetch(`${base}/analyze`, {method:'OPTIONS', headers:{Origin:'http://127.0.0.1:3086'}});
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
});

test('static serving cannot escape the frontend folder and unknown paths return 404 JSON', async () => {
  for (const path of ['/%2e%2e/server.mjs', '/..%2fpackage.json', '/%E0%A4%A', '/no-such-page']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).code, 'NOT_FOUND');
  }
});
