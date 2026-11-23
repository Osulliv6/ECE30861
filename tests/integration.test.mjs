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
import { htmlByteBoundary, htmlElementBoundary } from './fixtures/html-boundary.mjs';

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

test('HTML inherited inline color produces AA contrast findings and respects overrides', async () => {
  const html = '<!doctype html><html lang="en"><head><title>Test</title></head><body style="color:#aaaaaa"><p>Low contrast</p><p style="color:#000000">Readable</p></body></html>';
  const response = await upload(base, html, {type:'text/html', name:'contrast.html'});
  assert.equal(response.status, 200);
  const report = await response.json();
  const contrast = report.issues.filter(issue => issue.wcag_criterion === '1.4.3');
  assert.equal(contrast.length, 1);
  assert.match(contrast[0].location.snippet, /Low contrast/);
  const levelA = await upload(base, html, {type:'text/html', name:'contrast.html', level:'A'});
  assert.ok(!criteria(await levelA.json()).includes('1.4.3'));
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

test('HTML contrast checks nested spans using their own styles', async () => {
  const html = '<!doctype html><html lang="en"><head><title>Test</title></head><body><p style="color:#000">Readable <span style="color:#aaa">Faint text</span> readable again</p></body></html>';
  const response = await upload(base, html, {type:'text/html', name:'mixed.html'});
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.deepEqual(report.issues.map(i => [i.wcag_criterion, i.location.snippet]), [['1.4.3', 'Faint text']]);
});

test('HTML reports unlabeled form controls but accepts associated and ARIA labels', async () => {
  const html = `<!doctype html><html lang="en"><head><title>Contact</title></head><body>
    <label for="email">Email</label><input id="email" type="email">
    <span id="query-label">Search</span><input aria-labelledby="query-label">
    <input id="unlabeled" type="text" placeholder="Your name">
  </body></html>`;
  const report = await (await upload(base, html, {type:'text/html', name:'form-labels.html'})).json();
  assert.deepEqual(report.issues.map(i => [i.wcag_criterion, i.location?.selector]), [['4.1.2','#unlabeled']]);
});

test('HTML form controls handle wrapped labels, ignored control types, and unresolved ARIA references', async () => {
  const labelled = `<!doctype html><html lang="en"><head><title>Contact</title></head><body>
    <label>Accept policy <input type="checkbox"></label>
    <label for="country">Country</label><select id="country"><option>US</option></select>
    <textarea aria-label="Comments"></textarea><input type="hidden" value="token"><input type="submit" value="Send">
  </body></html>`;
  let report = await (await upload(base, labelled, {type:'text/html', name:'label-variants.html'})).json();
  assert.deepEqual(report.issues, []);

  const unresolved = '<!doctype html><html lang="en"><head><title>Contact</title></head><body><input id="missing-reference" aria-labelledby="does-not-exist"></body></html>';
  report = await (await upload(base, unresolved, {type:'text/html', name:'missing-aria-reference.html'})).json();
  assert.deepEqual(report.issues.map(i => [i.wcag_criterion, i.location?.selector]), [['4.1.2','#missing-reference']]);
});

test('HTML distinguishes data-table headers and link names from presentation markup', async () => {
  const html = `<!doctype html><html lang="en"><head><title>Schedule</title></head><body>
    <table id="good"><tr><th>Course</th><th>Credits</th></tr><tr><td>ECE</td><td>3</td></tr></table>
    <table id="missing"><tr><td>Course</td><td>Credits</td></tr><tr><td>ECE</td><td>3</td></tr></table>
    <table role="presentation"><tr><td>Decorative layout</td></tr></table>
    <a id="empty" href="/empty"></a><a id="generic" href="/details">click here</a><a id="url" href="https://example.com">https://example.com</a>
  </body></html>`;
  const report = await (await upload(base, html, {type:'text/html', name:'table-and-links.html'})).json();
  assert.deepEqual(report.issues.map(i => [i.wcag_criterion, i.location?.selector]), [
    ['1.3.1','#missing'],
    ['2.4.4','#empty'], ['2.4.4','#generic'], ['2.4.4','#url'],
  ]);
});

test('HTML image-only links, ARIA image names, role="none", and header-only table rows avoid false findings', async () => {
  const html = `<!doctype html><html lang="en"><head><title>Course links</title></head><body>
    <a id="home" href="/home"><img id="home-icon" src="home.png" alt="Home"></a>
    <a id="unnamed" href="/next"><img id="unnamed-icon" src="next.png"></a>
    <img id="search" src="search.png" alt="" aria-label="Search">
    <table id="layout" role="none"><tr><td>Left</td><td>Right</td></tr><tr><td>A</td><td>B</td></tr></table>
    <table id="single"><tr><th>Assignments</th></tr><tr><td>HW1</td></tr><tr><td>HW2</td></tr></table>
    <table id="grid"><tr><td></td><th>Mon</th><th>Tue</th></tr><tr><th>9am</th><td>Lecture</td><td>Lab</td></tr></table>
    <table id="missing"><tr><td>Course</td><td>Credits</td></tr><tr><td>ECE</td><td>3</td></tr></table>
  </body></html>`;
  const response = await upload(base, html, {type:'text/html', name:'accessible-names.html'});
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(parseReport(report), report);
  // Only the link/image with no name at all and the table without headers are reported.
  assert.deepEqual(report.issues.map(i => [i.wcag_criterion, i.location?.selector]).sort(), [
    ['1.1.1','#unnamed-icon'], ['1.3.1','#missing'], ['2.4.4','#unnamed'],
  ]);
});

test('DOCX document-default language prevents a false missing-language finding', async () => {
  const response = await upload(base, await fixture('default-language.docx'), {type:DOCX, name:'default-language.docx'});
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(parseReport(report), report);
  assert.ok(!criteria(report).includes('3.1.1'), JSON.stringify(criteria(report)));
});

test('untagged PDF gets one "not tagged" finding instead of guessed headings or alt text', async () => {
  const report = await (await upload(base, await fixture('course.pdf'), {type:'application/pdf', name:'course.pdf'})).json();
  assert.equal(parseReport(report), report);
  assert.deepEqual(criteria(report), ['1.3.1','2.4.4']);
  assert.equal(report.issues[0].location, null);
  assert.match(report.issues[0].description, /not tagged/);
  assert.deepEqual(report.issues[1].location, {page:1, snippet:'click here'});
});

test('tagged PDF is checked for heading order, figure alt text, and table headers from its tags', async () => {
  const report = await (await upload(base, await fixture('tagged.pdf'), {type:'application/pdf', name:'tagged.pdf'})).json();
  assert.equal(parseReport(report), report);
  assert.deepEqual(report.issues.map(i => [i.wcag_criterion, i.location?.page, i.location?.snippet]), [
    ['1.1.1', 1, 'Figure 1'],  // Figure without /Alt; Figure 2 has /Alt and is not reported
    ['1.3.1', 1, 'Grading'],   // H1 -> H3
    ['1.3.1', 2, 'Table'],     // page-2 table has no TH cells; page-1 table header is in THead
  ]);
  assert.ok(!report.issues.some(i => /not tagged/.test(i.description)));
});

test('a 10 MiB HTML file with 1.3 million elements is rejected quickly instead of timing out', async () => {
  const prefix = '<!doctype html><html lang="en"><head><title>Stress test</title></head><body>';
  const suffix = '</body></html>';
  const element = '<i></i>';
  const size = 10 * 1024 * 1024;
  const bytes = Buffer.from(prefix + element.repeat(1_300_000) + ' '.repeat(size - prefix.length - element.length * 1_300_000 - suffix.length) + suffix);
  assert.equal(bytes.length, size);
  const started = performance.now();
  const response = await upload(base, bytes, {type:'text/html', name:'large.html'});
  const durationMs = performance.now() - started;
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, 'UNPROCESSABLE_FILE');
  assert.ok(durationMs < 30_000, `response took ${Math.round(durationMs)} ms`);
});

test('HTML element limit accepts exactly 150,000 and rejects 150,001 within 30 seconds', async () => {
  const atLimit = htmlElementBoundary(150_000);
  const started = performance.now();
  let response = await upload(base, atLimit, {type:'text/html', name:'150000-elements.html'});
  assert.equal(response.status, 200);
  assert.equal(parseReport(await response.json()).issues.length, 0);
  assert.ok(performance.now() - started < 30_000, '150,000-element document exceeded 30 seconds');

  const overLimit = htmlElementBoundary(150_001);
  const overStarted = performance.now();
  response = await upload(base, overLimit, {type:'text/html', name:'150001-elements.html'});
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, 'UNPROCESSABLE_FILE');
  assert.ok(performance.now() - overStarted < 30_000, 'over-limit document was not rejected promptly');
});

test('HTML contrast uses colors and backgrounds from embedded stylesheets', async () => {
  const html = `<!doctype html><html lang="en"><head><title>Test</title><style>
    .muted { color: #999999 } .panel { background: #333333 } .panel p { color: #777777 }
    #ok p.muted { color: #222222 } .hero { background: url(hero.png) #000 }</style></head><body>
    <p class="muted">Muted note</p><div class="panel"><p>Dark panel</p></div><div id="ok"><p class="muted">Fine</p></div>
    <div class="hero"><p style="color:#fff">On image</p></div></body></html>`;
  const report = await (await upload(base, html, {type:'text/html', name:'styles.html'})).json();
  assert.equal(parseReport(report), report);
  const contrast = report.issues.filter(i => i.wcag_criterion === '1.4.3').map(i => i.location.snippet);
  assert.deepEqual(contrast, ['Muted note', 'Dark panel']);  // the override and the image background are not reported
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

test('HTML reports only unnamed exposed images, links, and controls at their source lines', async () => {
  const source = `<!doctype html><html lang="en"><head><title>Course</title></head><body>
    <img id="hidden" aria-hidden="true" src="blank.png">
    <div aria-hidden="true"><img id="hidden-descendant" src="blank.png"></div>
    <a id="hidden-only-link" href="/schedule"><img aria-hidden="true" alt="Schedule"></a>
    <a id="svg-link" href="/schedule"><svg role="img"><title>Course schedule</title></svg></a>
    <svg id="unnamed-svg" role="img"><circle r="5"/></svg>
    <svg id="labelled-svg" role="img" aria-label="Lab seating"><circle r="5"/></svg>
    <a id="anchor"></a><button id="empty-button"></button>
    <button id="named-button"><img alt="Print syllabus"></button>
    <input id="image-button" type="image" src="send.png"><input type="submit">
    <span id="preferred" hidden>Weekly schedule</span>
    <a id="name-precedence" href="/weekly" aria-labelledby="preferred" aria-label="Click here"></a>
    </body></html>`;
  const response = await upload(base, source, {type:'text/html', name:'accessible-names.html'});
  assert.equal(response.status, 200);
  const report = parseReport(await response.json());
  assert.deepEqual(report.issues.map(issue => [issue.wcag_criterion, issue.location.selector, issue.location.line]), [
    ['2.4.4','#hidden-only-link',4], ['1.1.1','#unnamed-svg',6],
    ['4.1.2','#empty-button',8], ['4.1.2','#image-button',10],
  ]);
});

test('text-heavy HTML at the 10 MiB limit returns a report despite the large parser result', async () => {
  const source = htmlByteBoundary();
  assert.equal(source.length, 10 * 1024 * 1024);
  const started = performance.now();
  const response = await upload(base, source, {type:'text/html', name:'text-heavy.html'});
  assert.equal(response.status, 200);
  assert.deepEqual(parseReport(await response.json()).issues, []);
  assert.ok(performance.now() - started < 30_000);
});

test('parser result exceeding the output budget gets a specific 422 and removes temp files', async () => {
  const limited = await start({parserOptions:{tmpRoot,maxOutputBytes:64}});
  const response = await upload(limited, 'Course schedule', {type:'text/plain',name:'notes.txt'});
  assert.equal(response.status, 422);
  const error = await response.json();
  assert.equal(error.code, 'UNPROCESSABLE_FILE');
  assert.match(error.message, /analysis result exceeds/);
  assert.deepEqual(await readdir(tmpRoot), []);
});

test('PDF reports scan and reading-order review notes by page, and flags only the unnamed widget', async () => {
  const analyzePdf = async name => {
    const response = await upload(base, await fixture(name), {type:'application/pdf', name});
    assert.equal(response.status, 200);
    return parseReport(await response.json());
  };
  const scan = await analyzePdf('mixed-scan.pdf');
  assert.deepEqual(scan.review_notes.map(note => note.page), [2]);
  assert.match(scan.review_notes[0].suggested_fix, /Run OCR/);
  assert.ok(!JSON.stringify(scan).includes('Read chapter one before lab'));
  assert.match(scan.issues[0].description, /not tagged/);
  const fields = (await analyzePdf('pdf-fields.pdf')).issues.filter(issue => issue.wcag_criterion === '4.1.2');
  assert.deepEqual(fields.map(issue => [issue.location.page, issue.location.snippet]), [[1,'field_1']]);
  assert.match(fields[0].suggested_fix, /Tooltip/);
  assert.equal((await analyzePdf('reading-order-correct.pdf')).review_notes, undefined);
  const mismatch = await analyzePdf('reading-order-mismatch.pdf');
  assert.deepEqual(mismatch.issues, []);
  assert.equal(mismatch.review_notes[0].page, 1);
  assert.match(mismatch.review_notes[0].description, /tag order may differ/);
});
