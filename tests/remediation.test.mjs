// POST /remediate end to end: upload -> server -> Python repair -> parser -> engine (before and after).
// Needs the parser's Python environment (accessibility-parser/.venv, or PYTHON=...).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, REMEDIATION_MESSAGE } from '../server.mjs';
import { parseRemediation } from '../frontend/core.js';

const fixture = name => readFile(new URL(`./fixtures/documents/${name}`, import.meta.url));
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const BROKEN_HTML = `<!doctype html><html><head><style>.muted { color: #aaaaaa }</style></head><body>
<h2>Course page</h2><h4>Grading</h4><p class="muted">Due Friday.</p><img src="chart.png"><a href="/r">click here</a>
<table><tr><td>Item</td><td>Weight</td></tr><tr><td>Exam</td><td>60%</td></tr></table></body></html>`;
let server, base, tmpRoot;

test.before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'ada-remediate-'));
  server = createServer({parserOptions:{tmpRoot}, log:() => {}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(tmpRoot, {recursive:true, force:true});
});

async function remediate(content, {type, name, fields = {}}) {
  const form = new FormData();
  if (content !== undefined) form.append('file', new Blob([content], type ? {type} : {}), name);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return fetch(`${base}/remediate`, {method:'POST', body:form});
}
const criteria = issues => issues.map(i => i.wcag_criterion);
const decode = result => Buffer.from(result.remediated_file.content_base64, 'base64');

test('HTML: repairs title, language, headings, table header, and contrast; alt text and link text remain', async () => {
  const response = await remediate(BROKEN_HTML, {type:'text/html', name:'week 1/notes.html', fields:{language:'en-US'}});
  assert.equal(response.status, 200);
  const result = parseRemediation(await response.json());
  assert.deepEqual(criteria(result.issues_before).sort(), ['1.1.1','1.3.1','1.3.1','1.3.1','1.4.3','2.4.2','2.4.4','3.1.1']);
  assert.deepEqual(criteria(result.issues_after), ['1.1.1','2.4.4']);
  assert.deepEqual(criteria(result.changes).sort(), ['1.3.1','1.3.1','1.3.1','1.4.3','2.4.2','3.1.1']);
  assert.equal(result.message, REMEDIATION_MESSAGE);
  assert.deepEqual({...result.remediated_file, content_base64:undefined}, {filename:'notes-remediated.html', mime_type:'text/html', size_bytes:decode(result).length, content_base64:undefined});
  const html = decode(result).toString('utf8');
  assert.match(html, /<html lang="en-US">/);
  assert.match(html, /<title>Course page<\/title>/);
  assert.match(html, /<th scope="col">Item<\/th>/);
});

test('the repaired file analyzes to exactly the reported remaining findings', async () => {
  const result = await (await remediate(BROKEN_HTML, {type:'text/html', name:'notes.html'})).json();
  const form = new FormData();
  form.append('file', new Blob([decode(result)], {type:'text/html'}), result.remediated_file.filename);
  const reanalyzed = await (await fetch(`${base}/analyze`, {method:'POST', body:form})).json();
  assert.deepEqual(reanalyzed.issues, result.issues_after);
});

test('DOCX: fixes the heading gap and header row, keeps alt text and link problems for a person', async () => {
  const result = parseRemediation(await (await remediate(await fixture('course.docx'), {type:DOCX, name:'course.docx'})).json());
  assert.deepEqual(criteria(result.issues_before), ['1.3.1','1.1.1','1.3.1','2.4.4']);
  assert.deepEqual(criteria(result.issues_after), ['1.1.1','2.4.4']);
  assert.equal(result.remediated_file.mime_type, DOCX);
  assert.deepEqual([...decode(result).subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
});

test('PDF: sets title and language; an untagged PDF still reports that it needs tags', async () => {
  const pdf = await fixture('course.pdf');
  const result = parseRemediation(await (await remediate(pdf, {type:'application/pdf', name:'course.pdf'})).json());
  assert.deepEqual(result.changes, []);  // course.pdf already has a title and language
  assert.deepEqual(criteria(result.issues_after), ['1.3.1','2.4.4']);
  assert.equal(decode(result).subarray(0, 5).toString('latin1'), '%PDF-');
});

test('level A excludes contrast from both the findings and the comparison', async () => {
  const result = await (await remediate(BROKEN_HTML, {type:'text/html', name:'notes.html', fields:{wcag_level:'A'}})).json();
  assert.ok(!criteria(result.issues_before).includes('1.4.3'));
  assert.ok(!criteria(result.issues_after).includes('1.4.3'));
});

test('plain text returns an unchanged copy, no changes, and the no-issue message', async () => {
  const notes = await fixture('notes.txt');
  const result = parseRemediation(await (await remediate(notes, {type:'text/plain', name:'notes.txt'})).json());
  assert.deepEqual([result.changes, result.issues_after], [[], []]);
  assert.deepEqual(decode(result), notes);
});

test('invalid requests use the shared error shape', async () => {
  const cases = [
    [await remediate(BROKEN_HTML, {type:'text/html', name:'a.html', fields:{language:'english!'}}), 400, 'INVALID_LANGUAGE'],
    [await remediate(BROKEN_HTML, {type:'text/html', name:'a.html', fields:{title:'x'.repeat(201)}}), 400, 'INVALID_TITLE'],
    [await remediate(BROKEN_HTML, {type:'text/html', name:'a.html', fields:{wcag_level:'AAA'}}), 400, 'INVALID_WCAG_LEVEL'],
    [await remediate(undefined, {fields:{language:'en'}}), 400, 'MISSING_FILE'],
    [await remediate(Buffer.alloc(0), {type:'text/html', name:'empty.html'}), 422, 'UNPROCESSABLE_FILE'],
    [await remediate(await fixture('corrupt.docx'), {type:DOCX, name:'corrupt.docx'}), 422, 'UNPROCESSABLE_FILE'],
    [await remediate('MZ', {type:'application/x-msdownload', name:'tool.exe'}), 415, 'UNSUPPORTED_MEDIA_TYPE'],
  ];
  for (const [response, status, code] of cases) {
    assert.equal(response.status, status, code);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['code','message']);
    assert.equal(body.code, code);
  }
});

test('a title from the request is cleaned of control characters and used only when the document has none', async () => {
  const result = await (await remediate(BROKEN_HTML, {type:'text/html', name:'a.html', fields:{title:'Week\u00011\nnotes'}})).json();
  assert.match(decode(result).toString('utf8'), /<title>Week 1 notes<\/title>/);
});

test('uploads and repaired copies are deleted after success and failure', async () => {
  await remediate(BROKEN_HTML, {type:'text/html', name:'a.html'});
  await remediate(await fixture('corrupt.docx'), {type:DOCX, name:'corrupt.docx'});
  assert.deepEqual(await readdir(tmpRoot), []);
});
