// Cross-team testing interface: system /test/* and tester /tester/test/* endpoints.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server.mjs';
import { SUITE } from '../testing/tester.mjs';

const servers = [];
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
// A fake target system whose handlers can misbehave on purpose.
function fakeTarget(routes) {
  return listen(http.createServer((req, res) => {
    const handler = routes[new URL(req.url, 'http://x').pathname];
    if (!handler) { res.writeHead(404, {'Content-Type':'application/json'}); return res.end(JSON.stringify({message:'Not found', source:'system'})); }
    let body = ''; req.on('data', c => body += c); req.on('end', () => handler(req, res, body));
  }));
}
const json = (res, status, body) => { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(body)); };
const post = (url, body) => fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:typeof body === 'string' ? body : JSON.stringify(body)});
const setupOk = (req, res, body) => json(res, 201, {session_id:JSON.parse(body).session_id});

let base;
test.before(async () => { base = await listen(createServer({testerOptions:{timeoutMs:2000}})); });
test.after(async () => Promise.all(servers.map(s => new Promise(resolve => { s.closeAllConnections?.(); s.close(resolve); }))));

test('system setup returns the supplied session ID once and rejects invalid or duplicate requests', async () => {
  let r = await post(`${base}/test/setup`, {session_id:'sys-1', setup:{}});
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), {session_id:'sys-1'});
  r = await post(`${base}/test/setup`, {session_id:'sys-1', setup:{}});
  assert.equal(r.status, 409);
  assert.deepEqual(Object.keys(await r.json()).sort(), ['message', 'source']);
  for (const bad of [{}, {session_id:''}, {session_id:'x', setup:[]}, '{not json']) {
    r = await post(`${base}/test/setup`, bad);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).source, 'system');
  }
  assert.equal((await fetch(`${base}/test/setup`)).status, 405);
});

test('system report returns code coverage for known sessions only', async () => {
  await post(`${base}/test/setup`, {session_id:'sys-2', setup:{}});
  const r = await fetch(`${base}/test/report?session_id=sys-2`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.session_id, 'sys-2');
  assert.deepEqual([body.coverage.code.covered, body.coverage.code.total], [null, null]);
  assert.ok(body.coverage.code.basis.length > 0);
  assert.equal((await fetch(`${base}/test/report?session_id=nope`)).status, 404);
  assert.equal((await fetch(`${base}/test/report`)).status, 400);
});

test('tester runs the full suite against this system once and stores an unchanged report', async () => {
  let r = await post(`${base}/tester/test/setup`, {target_url:`${base}/`});
  assert.equal(r.status, 201);
  const {session_id} = await r.json();
  assert.equal((await fetch(`${base}/tester/test/report?session_id=${session_id}`)).status, 409);
  r = await post(`${base}/tester/test/run`, {session_id});
  assert.equal(r.status, 200);
  const report = await r.json();
  assert.equal(report.session_id, session_id);
  assert.equal(report.target_url, base);
  assert.deepEqual(report.results.map(x => x.test_id), SUITE.map(t => t.id));
  assert.ok(report.results.every(x => x.outcome === 'pass' && x.message.trim()), JSON.stringify(report.results.filter(x => x.outcome !== 'pass')));
  for (const key of ['code', 'component', 'system']) assert.ok(report.coverage[key].basis.trim(), key);
  assert.equal((await post(`${base}/tester/test/run`, {session_id})).status, 409);
  assert.deepEqual(await (await fetch(`${base}/tester/test/report?session_id=${session_id}`)).json(), report);
});

test('tester setup validates target_url and forwards or explains system setup failures', async () => {
  for (const target_url of ['ftp://x.edu', 'https://u:p@x.edu', 'https://x.edu?q=1', 'not a url', 42]) {
    const r = await post(`${base}/tester/test/setup`, {target_url});
    assert.equal(r.status, 400, String(target_url));
    assert.equal((await r.json()).source, 'tester');
  }
  const failing = await fakeTarget({'/test/setup':(req, res) => json(res, 500, {message:'Could not initialize the session database.', source:'system'})});
  let r = await post(`${base}/tester/test/setup`, {target_url:failing});
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), {message:'Could not initialize the session database.', source:'system'});
  const missing = await fakeTarget({});
  r = await post(`${base}/tester/test/setup`, {target_url:missing});
  assert.equal(r.status, 404);
  const closed = await listen(http.createServer());
  servers.pop().close();
  await new Promise(resolve => setTimeout(resolve, 50));
  r = await post(`${base}/tester/test/setup`, {target_url:closed});
  assert.equal(r.status, 500);
  assert.equal((await r.json()).source, 'communication');
});

test('tester records system errors, failed expectations, timeouts, and unsupported formats per test', async () => {
  const target = await fakeTarget({
    '/test/setup':setupOk,
    '/health':() => {},  // never responds: communication timeout
    '/formats':(req, res) => json(res, 200, {supported_mime_types:['text/html'], max_file_size_mb:10}),
    '/analyze':(req, res) => json(res, 500, {message:'Engine crashed', source:'system'}),
    '/test/report':(req, res) => json(res, 503, {}),
  });
  const {session_id} = await (await post(`${base}/tester/test/setup`, {target_url:target})).json();
  const report = await (await post(`${base}/tester/test/run`, {session_id})).json();
  const byId = Object.fromEntries(report.results.map(x => [x.test_id, x]));
  assert.deepEqual([byId['T-01'].outcome, byId['T-01'].source], ['error', 'communication']);
  assert.equal(byId['T-02'].outcome, 'pass');
  assert.deepEqual([byId['T-03'].outcome, byId['T-03'].source], ['error', 'system']);
  for (const id of ['T-07', 'T-08', 'T-11']) assert.equal(byId[id].outcome, 'skip', id);
  assert.match(report.coverage.code.basis, /HTTP 503/);
  assert.equal(report.coverage.code.covered, null);

  const wrong = await fakeTarget({'/test/setup':setupOk, '/analyze':(req, res) => json(res, 200, {issues:[{description:'incomplete'}]})});
  const s2 = (await (await post(`${base}/tester/test/setup`, {target_url:wrong})).json()).session_id;
  const r2 = await (await post(`${base}/tester/test/run`, {session_id:s2})).json();
  assert.equal(r2.results.find(x => x.test_id === 'T-03').outcome, 'fail');
  assert.equal(r2.results.find(x => x.test_id === 'T-01').outcome, 'fail');
});

test('tester run and report reject unknown or missing sessions', async () => {
  assert.equal((await post(`${base}/tester/test/run`, {session_id:'unknown'})).status, 404);
  assert.equal((await post(`${base}/tester/test/run`, {})).status, 400);
  assert.equal((await fetch(`${base}/tester/test/report?session_id=unknown`)).status, 404);
  assert.equal((await fetch(`${base}/tester/test/report`)).status, 400);
});
