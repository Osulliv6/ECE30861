// Run against a local server or an authorized staging deployment.
import { htmlByteBoundary, htmlElementBoundary } from '../tests/fixtures/html-boundary.mjs';
import { parseReport } from '../frontend/core.js';

const [baseArg, cold] = process.argv.slice(2);
if (!baseArg || (cold && cold !== '--cold')) {
  throw new Error('Usage: node scripts/benchmark-html.mjs BASE_URL [--cold]');
}
const base = new URL(baseArg);
if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Expected an HTTP(S) service URL.');
const url = base.href.replace(/\/$/, '');
let started = performance.now();
const health = await fetch(url + '/health', {signal:AbortSignal.timeout(90_000)});
if (!health.ok || (await health.json()).status !== 'ok') throw new Error('Service health check failed.');
console.log(JSON.stringify({case:cold ? 'first-request-after-idle' : 'health', ms:Math.round(performance.now() - started)}));

const cases = [
  ['150000-elements', htmlElementBoundary(150_000), 200],
  ['150001-elements', htmlElementBoundary(150_001), 422],
  ['10-mib-text-heavy', htmlByteBoundary(), 200],
];
for (const [name, bytes, expected] of cases) {
  for (let run = 1; run <= 3; run++) {
    const body = new FormData();
    body.set('file', new Blob([bytes], {type:'text/html'}), name + '.html');
    started = performance.now();
    const response = await fetch(url + '/analyze', {method:'POST', body, signal:AbortSignal.timeout(30_000)});
    const result = await response.json();
    const ms = Math.round(performance.now() - started);
    console.log(JSON.stringify({case:name, run, bytes:bytes.length, status:response.status, ms}));
    if (response.status !== expected) {
      process.exitCode = 1;
      continue;
    }
    if (expected === 200) parseReport(result);
    if (expected === 422 && result.code !== 'UNPROCESSABLE_FILE') process.exitCode = 1;
  }
}
