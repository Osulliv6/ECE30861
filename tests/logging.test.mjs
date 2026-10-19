// Request logging: one JSON line per request, with no uploaded file names or contents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from '../server.mjs';

test('requests are logged as JSON with status and error code, without private details', async () => {
  const lines = [];
  const server = createServer({log:line => lines.push(line)});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const upload = (bytes, type, name) => { const form = new FormData(); form.append('file', new Blob([bytes], {type}), name); return fetch(`${base}/analyze`, {method:'POST', body:form}); };
    await (await fetch(`${base}/health`)).text();
    await (await fetch(`${base}/`)).text();
    await (await upload(await readFile(new URL('./fixtures/documents/notes.txt', import.meta.url)), 'text/plain', 'student-grades-private.txt')).text();
    await (await upload(Buffer.from('MZ'), 'application/x-msdownload', 'student-grades-private.exe')).text();
    await (await fetch(`${base}/test/report?session_id=private-session-id`)).text();
    await new Promise(resolve => setImmediate(resolve));
    const entries = lines.map(line => JSON.parse(line));
    assert.deepEqual(entries.map(e => [e.method, e.path, e.status]), [['POST','/analyze',200], ['POST','/analyze',415], ['GET','/test/report',404]]);
    assert.equal(entries[1].error_code, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal(entries[2].error_source, 'system');
    assert.ok(entries.every(e => Number.isInteger(e.duration_ms) && !Number.isNaN(Date.parse(e.time))));
    assert.ok(!lines.join('\n').includes('student-grades-private'));
    assert.match(entries[2].detail, /Unknown session/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
