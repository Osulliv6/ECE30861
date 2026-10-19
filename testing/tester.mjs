// Tester side of the cross-team testing interface (POST /test/setup, POST /test/run,
// GET /test/report). It runs this team's suite against any target system's project
// API (/health, /formats, /analyze) and returns one report with results and coverage.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseReport } from '../frontend/core.js';
import { SessionStore, TestInterfaceError, isSessionId } from './system.mjs';

const FIXTURES = new URL('../tests/fixtures/documents/', import.meta.url);
const POD_SPEC = JSON.parse(readFileSync(new URL('./pod-spec.json', import.meta.url), 'utf8'));
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// Free-tier hosts can take up to a minute to wake, so each target call gets a generous limit.
const CALL_TIMEOUT_MS = 60_000;

class CommunicationError extends Error {}

const pass = message => ({outcome:'pass', message});
const fail = message => ({outcome:'fail', message});
const skip = message => ({outcome:'skip', message});
const error = (source, message) => ({outcome:'error', source, message});
const brief = body => { const text = typeof body === 'string' ? body : JSON.stringify(body); return text.length > 200 ? `${text.slice(0, 199)}…` : text; };

function client(baseUrl, timeoutMs) {
  async function request(method, path, body) {
    let response;
    try { response = await fetch(baseUrl + path, {method, body, signal:AbortSignal.timeout(timeoutMs), redirect:'error'}); }
    catch (cause) { throw new CommunicationError(cause.name === 'TimeoutError' ? `${method} ${path} timed out after ${timeoutMs / 1000} s with no response.` : `${method} ${path} failed: ${cause.message}.`); }
    const text = await response.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* keep text for the message */ }
    return {status:response.status, body:parsed};
  }
  return {
    get: path => request('GET', path),
    analyze({bytes, type, name, level = 'AA', file = true}) {
      const form = new FormData();
      if (file) form.append('file', new Blob([bytes], {type}), name);
      form.append('wcag_level', level);
      return request('POST', '/analyze', form);
    },
  };
}

// A non-matching response is a system error when the target reports a server failure, otherwise a failed expectation.
function unexpected(response, expected) {
  const detail = `Expected ${expected}; received HTTP ${response.status}: ${brief(response.body)}`;
  return response.status >= 500 ? error('system', detail) : fail(detail);
}

function expectReport(response, {includes = [], excludes = [], clean = false} = {}) {
  if (response.status !== 200) return unexpected(response, 'HTTP 200 with an accessibility report');
  try { parseReport(response.body); } catch (e) { return fail(`Report does not match the shared report format: ${e.message}`); }
  const criteria = response.body.issues.map(issue => issue.wcag_criterion);
  const found = criteria.join(', ') || 'none';
  if (clean && criteria.length) return fail(`Expected no issues; received criteria ${found}.`);
  const missing = includes.filter(c => !criteria.includes(c)), extra = excludes.filter(c => criteria.includes(c));
  if (missing.length) return fail(`Expected criteria ${includes.join(', ')}; missing ${missing.join(', ')} (received ${found}).`);
  if (extra.length) return fail(`Expected criteria ${extra.join(', ')} to be absent; received ${found}.`);
  return pass(`Received HTTP 200 with a valid report; criteria: ${found}.`);
}

function expectProjectError(response, status) {
  const message = response.body?.error?.message ?? response.body?.message;
  if (response.status !== status) return unexpected(response, `HTTP ${status} with an error message`);
  if (typeof message !== 'string' || !message.trim()) return fail(`Received HTTP ${status} but the body has no error message: ${brief(response.body)}`);
  return pass(`Received the expected HTTP ${status} error: "${message}"`);
}

// Skips format-specific tests when the target's /formats does not list that format.
const unsupported = (ctx, type) => ctx.formats && !ctx.formats.includes(type) ? skip(`Target does not list ${type} in /formats.`) : null;

const fixture = name => readFileSync(new URL(name, FIXTURES));
const html = body => Buffer.from(`<!doctype html><html lang="en"><head><title>Course page</title></head><body>${body}</body></html>`);

export const SUITE = [
  {id:'T-01', name:'Health check reports ok', run:async (api) => {
    const r = await api.get('/health');
    return r.status === 200 && r.body?.status === 'ok' ? pass('Received HTTP 200 with {"status":"ok"}.') : unexpected(r, 'HTTP 200 with {"status":"ok"}');
  }},
  {id:'T-02', name:'Formats lists MIME types and a limit of at least 10 MB', run:async (api, ctx) => {
    const r = await api.get('/formats'), types = r.body?.supported_mime_types, limit = r.body?.max_file_size_mb;
    if (r.status !== 200) return unexpected(r, 'HTTP 200 with supported formats');
    if (!Array.isArray(types) || !types.length || !types.every(t => typeof t === 'string' && t.includes('/'))) return fail(`supported_mime_types must be a nonempty array of MIME types; received ${brief(types)}.`);
    if (typeof limit !== 'number' || limit < 10) return fail(`max_file_size_mb must be a number of at least 10; received ${brief(limit)}.`);
    ctx.formats = types;
    return pass(`Received ${types.length} MIME types and a ${limit} MB limit.`);
  }},
  {id:'T-03', name:'HTML image without alt text is reported under 1.1.1', run:async (api) =>
    expectReport(await api.analyze({bytes:html('<h1>Course</h1><img src="chart.png">'), type:'text/html', name:'missing-alt.html'}), {includes:['1.1.1']})},
  {id:'T-04', name:'Low-contrast text is reported under 1.4.3 at level AA', run:async (api) =>
    expectReport(await api.analyze({bytes:html('<h1>Course</h1><p style="color:#949494">Due Friday at noon.</p>'), type:'text/html', name:'contrast.html', level:'AA'}), {includes:['1.4.3']})},
  {id:'T-05', name:'Level A excludes the AA-only contrast criterion', run:async (api) =>
    expectReport(await api.analyze({bytes:html('<h1>Course</h1><p style="color:#949494">Due Friday at noon.</p>'), type:'text/html', name:'contrast.html', level:'A'}), {excludes:['1.4.3']})},
  {id:'T-06', name:'Accessible HTML returns the no-issue report with a message', run:async (api) =>
    expectReport(await api.analyze({bytes:html('<h1>Course</h1><img src="chart.png" alt="Bar chart of weekly attendance"><p>Welcome to the course.</p>'), type:'text/html', name:'clean.html'}), {clean:true})},
  {id:'T-07', name:'DOCX image without alt text is reported under 1.1.1', run:async (api, ctx) =>
    unsupported(ctx, DOCX) ?? expectReport(await api.analyze({bytes:fixture('course.docx'), type:DOCX, name:'course.docx'}), {includes:['1.1.1']})},
  {id:'T-08', name:'PDF upload returns a valid report', run:async (api, ctx) =>
    unsupported(ctx, 'application/pdf') ?? expectReport(await api.analyze({bytes:fixture('course.pdf'), type:'application/pdf', name:'course.pdf'}))},
  {id:'T-09', name:'Unsupported file type returns 415', run:async (api) =>
    expectProjectError(await api.analyze({bytes:Buffer.from('MZ not a document'), type:'application/x-msdownload', name:'program.exe'}), 415)},
  {id:'T-10', name:'Empty file returns 422', run:async (api) =>
    expectProjectError(await api.analyze({bytes:Buffer.alloc(0), type:'text/html', name:'empty.html'}), 422)},
  {id:'T-11', name:'Corrupt DOCX returns 422', run:async (api, ctx) =>
    unsupported(ctx, DOCX) ?? expectProjectError(await api.analyze({bytes:fixture('corrupt.docx'), type:DOCX, name:'corrupt.docx'}), 422)},
  {id:'T-12', name:'Request without a file returns 400', run:async (api) =>
    expectProjectError(await api.analyze({file:false}), 400)},
  {id:'T-13', name:'Invalid wcag_level returns 400', run:async (api) =>
    expectProjectError(await api.analyze({bytes:html('<h1>Course</h1>'), type:'text/html', name:'level.html', level:'AAA'}), 400)},
];

// Component and system coverage count pod-defined items exercised by at least one executed test.
function podCoverage(spec, results) {
  if (!spec.items) return {covered:null, total:null, basis:spec.basis};
  const executed = new Set(results.filter(r => r.outcome !== 'skip').map(r => r.test_id));
  const items = Object.values(spec.items);
  return {covered:items.filter(tests => tests.some(t => executed.has(t))).length, total:items.length, basis:spec.basis};
}

async function codeCoverage(target, sessionId, timeoutMs) {
  try {
    const r = await client(target, timeoutMs).get(`/test/report?session_id=${encodeURIComponent(sessionId)}`);
    const code = r.body?.coverage?.code;
    if (r.status === 200 && code && typeof code.basis === 'string' && code.basis.trim()) return code;
    return {covered:null, total:null, basis:`Unavailable: target /test/report returned HTTP ${r.status}.`};
  } catch (e) {
    return {covered:null, total:null, basis:`Unavailable: ${e.message}`};
  }
}

function normalizeTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new TestInterfaceError(400, '"target_url" must be an absolute http(s) URL.', 'tester'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TestInterfaceError(400, '"target_url" must be an http(s) URL without credentials, query, or fragment.', 'tester');
  return url.href.replace(/\/+$/, '');
}

export function createTesterInterface({timeoutMs = CALL_TIMEOUT_MS, suite = SUITE, podSpec = POD_SPEC} = {}) {
  const sessions = new SessionStore();
  const lookup = sessionId => {
    if (!isSessionId(sessionId)) throw new TestInterfaceError(400, 'A nonempty string "session_id" is required.', 'tester');
    const session = sessions.get(sessionId);
    if (!session) throw new TestInterfaceError(404, `Unknown session "${sessionId}".`, 'tester');
    return session;
  };
  return {
    async setup(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.target_url !== 'string') throw new TestInterfaceError(400, 'Request body must include a string "target_url".', 'tester');
      const target = normalizeTarget(body.target_url), sessionId = randomUUID();
      let response;
      try {
        response = await fetch(`${target}/test/setup`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({session_id:sessionId, setup:{}}), signal:AbortSignal.timeout(timeoutMs), redirect:'error'});
      } catch (e) {
        throw new TestInterfaceError(500, `System setup at ${target} could not be reached: ${e.name === 'TimeoutError' ? 'timed out' : e.message}.`, 'communication');
      }
      let reply = null;
      try { reply = await response.json(); } catch { /* non-JSON reply handled below */ }
      if (response.status !== 201) {
        // Forward the system's own status, message, and source.
        throw new TestInterfaceError(response.status >= 400 ? response.status : 500, typeof reply?.message === 'string' && reply.message.trim() ? reply.message : `System setup returned HTTP ${response.status}.`, typeof reply?.source === 'string' ? reply.source : 'system');
      }
      if (reply?.session_id !== sessionId) throw new TestInterfaceError(500, 'System setup returned 201 without the supplied session ID.', 'system');
      sessions.set(sessionId, {target, state:'ready', report:null});
      return {status:201, body:{session_id:sessionId}};
    },
    async run(body) {
      const session = lookup(body?.session_id);
      if (session.state !== 'ready') throw new TestInterfaceError(409, `Session "${body.session_id}" has already been run.`, 'tester');
      session.state = 'running';
      const api = client(session.target, timeoutMs), ctx = {formats:null}, results = [];
      const report = () => ({session_id:body.session_id, target_url:session.target, results});
      try {
        for (const test of suite) {
          let result;
          try { result = await test.run(api, ctx); }
          catch (e) { result = e instanceof CommunicationError ? error('communication', e.message) : error('tester', `Test code failed: ${e.message}`); }
          results.push({test_id:test.id, ...result});
        }
        const coverage = {
          code:await codeCoverage(session.target, body.session_id, timeoutMs),
          component:podCoverage(podSpec.components, results),
          system:podCoverage(podSpec.acceptance_criteria, results),
        };
        session.report = {...report(), coverage};
        session.state = 'done';
        return {status:200, body:session.report};
      } catch (e) {
        // Abort: keep recorded outcomes and mark every test that did not finish as skipped.
        const done = new Set(results.map(r => r.test_id));
        for (const test of suite) if (!done.has(test.id)) results.push({test_id:test.id, outcome:'skip', message:'Not executed because the tester aborted.'});
        const unavailable = {covered:null, total:null, basis:'Unavailable: the tester aborted before measuring coverage.'};
        session.report = {...report(), coverage:{code:unavailable, component:unavailable, system:unavailable}};
        session.state = 'aborted';
        throw new TestInterfaceError(500, `The tester aborted: ${e.message}`, 'tester');
      }
    },
    report(sessionId) {
      const session = lookup(sessionId);
      if (!session.report) throw new TestInterfaceError(409, 'The suite has not ended; retry the lookup later.', 'tester');
      return {status:200, body:session.report};
    },
  };
}
