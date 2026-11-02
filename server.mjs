import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, resolve, sep } from 'node:path';
import { analyze, EngineError } from './engine/index.mjs';
import { parseUpload, remediateUpload, ParserError } from './accessibility-parser/integration.mjs';
import { createSystemInterface, TestInterfaceError } from './testing/system.mjs';
import { createTesterInterface } from './testing/tester.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(moduleDir, 'frontend');
// Cross-team tester treats 10 MB as 10 MiB (10 * 1,048,576 bytes).
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json'};

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff', ...headers});
  res.end(JSON.stringify(body));
}
function failure(res, status, code, message) { res.logFields = {...res.logFields, error_code:code}; sendJson(res, status, {code,message}); }
const utf8 = bytes => { try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { return null; } };
// Each supported type: the extension the parser expects and a check that the bytes really are that format.
// Browser MIME types are only hints, so the content check is authoritative.
const FORMATS = {
  'text/html':{ext:'.html',matches:b=>/<(?:!doctype\s+html|html[\s>])/i.test(utf8(b) ?? '')},
  'application/pdf':{ext:'.pdf',matches:b=>b.subarray(0,5).toString('latin1') === '%PDF-'},
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':{ext:'.docx',matches:b=>b.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04]))},
  'text/plain':{ext:'.txt',matches:b=>{ const t = utf8(b); return t !== null && !t.includes('\0') && t.trim() !== ''; }},
};
const EXTENSION_TYPES = {'.html':'text/html','.htm':'text/html','.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.txt':'text/plain'};
export const SUPPORTED_MIME_TYPES = Object.keys(FORMATS);
function uploadType(file) { return FORMATS[file.contentType] ? file.contentType : EXTENSION_TYPES[extname(file.filename || '').toLowerCase()]; }

function readBody(req, maxBytes) { return new Promise((resolveBody,reject) => { let size = 0, settled = false; const chunks = []; req.on('data',chunk => { if (settled) return; size += chunk.length; if (size > maxBytes) { settled = true; chunks.length = 0; reject(Object.assign(new Error('too large'),{code:'FILE_TOO_LARGE'})); req.resume(); return; } chunks.push(chunk); }); req.on('end',()=>{ if (!settled) resolveBody(Buffer.concat(chunks)); }); req.on('error',error=>{ if (!settled) reject(error); }); }); }
function parseMultipart(body, contentType) {
  const found = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType), boundary = found?.[1] || found?.[2]; if (!boundary) throw new Error('Missing multipart boundary.');
  const marker = Buffer.from(`--${boundary}`), parts = []; let cursor = body.indexOf(marker);
  while (cursor >= 0) { const next = body.indexOf(marker,cursor + marker.length); if (next < 0) break; let part = body.subarray(cursor + marker.length,next); if (part.subarray(0,2).equals(Buffer.from('\r\n'))) part = part.subarray(2); if (part.subarray(-2).equals(Buffer.from('\r\n'))) part = part.subarray(0,-2); const split = part.indexOf(Buffer.from('\r\n\r\n')); if (split >= 0) { const headers = part.subarray(0,split).toString('latin1'), disposition = /content-disposition:\s*form-data;[^\r\n]*/i.exec(headers)?.[0] || '', name = /\bname="([^"]+)"/i.exec(disposition)?.[1]; if (name) parts.push({name,filename:/\bfilename="([^"]*)"/i.exec(disposition)?.[1],contentType:/content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.toLowerCase(),data:part.subarray(split + 4)}); } cursor = next; }
  return parts;
}
function setCors(req,res,origins) { const origin = req.headers.origin; if (origin && (origins === '*' || origins.includes(origin))) { res.setHeader('Access-Control-Allow-Origin',origin); res.setHeader('Vary','Origin'); } }
async function serveStatic(req,res) { try { const path = decodeURIComponent(new URL(req.url,'http://localhost').pathname), file = resolve(frontendRoot,'.' + (path === '/' ? '/index.html' : path)); if (!file.startsWith(frontendRoot + sep)) return false; const data = await readFile(file); res.writeHead(200,{'Content-Type':mime[extname(file)] || 'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(req.method === 'HEAD' ? undefined : data); return true; } catch { return false; } }

// Reads and validates one document upload shared by /analyze and /remediate. Returns
// {file, type, fields} or null after sending the error response.
async function readUpload(req, res) {
  if (Number(req.headers['content-length']) > MAX_FILE_SIZE_BYTES + 16_384) return failure(res,413,'FILE_TOO_LARGE','The file exceeds the 10 MB service limit.');
  if (!req.headers['content-type']?.toLowerCase().startsWith('multipart/form-data')) return failure(res,400,'MALFORMED_REQUEST','Submit one file as multipart/form-data.');
  const parts = parseMultipart(await readBody(req,MAX_FILE_SIZE_BYTES + 16_384),req.headers['content-type']);
  const file = parts.find(part=>part.name === 'file' && part.filename !== undefined);
  const field = name => parts.find(part=>part.name === name && part.filename === undefined)?.data.toString('utf8');
  const fields = {level:field('wcag_level') || 'AA', language:field('language'), title:field('title')};
  if (!file) return failure(res,400,'MISSING_FILE','Submit one file in the "file" field.');
  if (!file.data.length) return failure(res,422,'UNPROCESSABLE_FILE','The file is empty.');
  if (file.data.length > MAX_FILE_SIZE_BYTES) return failure(res,413,'FILE_TOO_LARGE','The file exceeds the 10 MB service limit.');
  const type = uploadType(file);
  if (!type) return failure(res,415,'UNSUPPORTED_MEDIA_TYPE','Supported formats are HTML, PDF, DOCX, and plain text.');
  if (!['A','AA'].includes(fields.level)) return failure(res,400,'INVALID_WCAG_LEVEL','wcag_level must be "A" or "AA".');
  if (!FORMATS[type].matches(file.data)) return failure(res,422,'UNPROCESSABLE_FILE','The file is corrupt or does not match its file type.');
  return {file, type, fields};
}

function uploadFailure(res, error) {
  if (error?.code === 'FILE_TOO_LARGE') return failure(res,413,'FILE_TOO_LARGE','The file exceeds the 10 MB service limit.');
  if (error instanceof ParserError) { res.logFields = {detail:error.message}; return failure(res,error.status,error.code,error.message); }
  if (error instanceof EngineError) { res.logFields = {detail:error.message}; return failure(res,503,'PROCESSING_UNAVAILABLE','The file could not be evaluated.'); }
  return failure(res,400,'MALFORMED_REQUEST','The upload could not be read.');
}

async function analyzeRequest(req, res, parserOptions) {
  try {
    const upload = await readUpload(req,res);
    if (!upload) return;
    return sendJson(res,200,analyze(await parseUpload(upload.file.data,FORMATS[upload.type].ext,parserOptions),{wcagLevel:upload.fields.level}));
  } catch (error) { return uploadFailure(res,error); }
}

// BCP 47 language tag, as checked by the engine for WCAG 3.1.1.
const LANGUAGE_TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;
export const TITLE_MAX_LENGTH = 200;
export const REMEDIATION_MESSAGE = 'Automated repairs were applied where a safe fix exists. Review every change marked for review, fix the remaining findings by hand, and recheck the document. This does not certify full ADA or WCAG compliance.';
// Download name for the repaired file: the uploaded name reduced to safe characters.
function remediatedName(filename, ext) {
  const stem = (filename || '').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'document';
  return `${stem}-remediated${ext}`;
}

// POST /remediate: repairs what can be repaired safely and returns the repaired file
// (base64), the list of changes, and the findings before and after (re-analyzed by the engine).
async function remediateRequest(req, res, parserOptions) {
  try {
    const upload = await readUpload(req,res);
    if (!upload) return;
    const {language, title, level} = upload.fields;
    if (language !== undefined && !LANGUAGE_TAG.test(language.trim())) return failure(res,400,'INVALID_LANGUAGE','language must be a BCP 47 tag such as "en" or "en-US".');
    // Control characters are removed so the title is safe in every document format.
    const cleanTitle = title?.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (cleanTitle !== undefined && cleanTitle.length > TITLE_MAX_LENGTH) return failure(res,400,'INVALID_TITLE',`title must be at most ${TITLE_MAX_LENGTH} characters.`);
    const {ext} = FORMATS[upload.type];
    const result = await remediateUpload(upload.file.data, ext, {language:language?.trim() || undefined, title:cleanTitle || undefined}, parserOptions);
    const before = analyze(result.before,{wcagLevel:level}), after = analyze(result.after,{wcagLevel:level});
    res.logFields = {changes:result.changes.length, issues_before:before.issues.length, issues_after:after.issues.length};
    return sendJson(res,200,{
      remediated_file:{filename:remediatedName(upload.file.filename, ext), mime_type:upload.type, size_bytes:result.bytes.length, content_base64:result.bytes.toString('base64')},
      changes:result.changes,
      issues_before:before.issues,
      issues_after:after.issues,
      message:REMEDIATION_MESSAGE,
    });
  } catch (error) { return uploadFailure(res,error); }
}

// Cross-team testing interface: errors use {message, source} as the course spec requires.
async function readJson(req, source) {
  try { return JSON.parse((await readBody(req,65_536)).toString('utf8') || 'null'); }
  catch { throw new TestInterfaceError(400,'Request body must be valid JSON.',source); }
}
async function testEndpoint(res, source, operation) {
  try {
    const {status, body} = await operation();
    // Tester runs log an outcome summary so failures in cross-team runs are visible.
    if (Array.isArray(body?.results)) res.logFields = {outcomes:Object.fromEntries(['pass','fail','error','skip'].map(o=>[o,body.results.filter(r=>r.outcome===o).length]))};
    sendJson(res,status,body);
  } catch (error) {
    res.logFields = {error_source:error.source || source, detail:error.message};
    if (error instanceof TestInterfaceError) return sendJson(res,error.status,{message:error.message,source:error.source});
    sendJson(res,500,{message:'Unexpected service failure.',source});
  }
}
const TEST_ROUTES = {
  '/test/setup':{method:'POST',source:'system',run:(api,req)=>readJson(req,'system').then(body=>api.system.setup(body))},
  '/test/report':{method:'GET',source:'system',run:(api,req,url)=>api.system.report(url.searchParams.get('session_id'))},
  '/tester/test/setup':{method:'POST',source:'tester',run:(api,req)=>readJson(req,'tester').then(body=>api.tester.setup(body))},
  '/tester/test/run':{method:'POST',source:'tester',run:(api,req)=>readJson(req,'tester').then(body=>api.tester.run(body))},
  '/tester/test/report':{method:'GET',source:'tester',run:(api,req,url)=>api.tester.report(url.searchParams.get('session_id'))},
};

// parserOptions: {python, timeoutMs, tmpRoot} for the Python parser bridge (defaults suit production).
// One JSON line per request. Uploaded file names and contents are never logged; error details may name a test session ID.
// Successful health checks and static files are skipped to keep the hosting platform's checks out of the log.
function logRequest(log, req, res, path, started) {
  res.on('finish', () => {
    const isStatic = !TEST_ROUTES[path] && !['/health','/formats','/analyze','/remediate'].includes(path);
    if (res.statusCode < 400 && (path === '/health' || isStatic)) return;
    log(JSON.stringify({time:new Date().toISOString(), method:req.method, path, status:res.statusCode, duration_ms:Math.round(performance.now() - started), ...res.logFields}));
  });
}

// testerOptions: {timeoutMs} for calls the tester makes to a target system. log: receives each log line.
export function createServer({allowedOrigins = (process.env.CORS_ORIGINS || 'http://127.0.0.1:3086,http://localhost:3086').split(','), parserOptions = {}, testerOptions = {}, log = line => console.log(line)} = {}) {
  const testApi = {system:createSystemInterface(), tester:createTesterInterface(testerOptions)};
  return http.createServer(async (req,res) => {
    const started = performance.now();
    logRequest(log, req, res, new URL(req.url,'http://localhost').pathname, started);
    setCors(req,res,allowedOrigins);
    if (req.method === 'OPTIONS') { res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'}); return res.end(); }
    const url = new URL(req.url,'http://localhost'), path = url.pathname;
    // The tester base URL itself describes the tester endpoints, so the registry link is useful in a browser.
    if (req.method === 'GET' && (path === '/tester' || path === '/tester/')) return sendJson(res,200,{service:'ECE 30861 Team 20 tester (course testing interface)',endpoints:['POST /test/setup','POST /test/run','GET /test/report']});
    const route = TEST_ROUTES[path];
    if (route) {
      if (req.method !== route.method) return sendJson(res,405,{message:`Use ${route.method} for ${path}.`,source:route.source},{Allow:route.method});
      return testEndpoint(res,route.source,()=>route.run(testApi,req,url));
    }
    if (req.method === 'GET' && path === '/health') return sendJson(res,200,{status:'ok'});
    if (req.method === 'GET' && path === '/formats') return sendJson(res,200,{supported_mime_types:SUPPORTED_MIME_TYPES,max_file_size_mb:10});
    if (req.method === 'POST' && path === '/analyze') return analyzeRequest(req,res,parserOptions);
    if (req.method === 'POST' && path === '/remediate') return remediateRequest(req,res,parserOptions);
    if (['GET','HEAD'].includes(req.method) && await serveStatic(req,res)) return;
    failure(res,404,'NOT_FOUND','Endpoint not found.');
  });
}
// HOST defaults to loopback for local use; deployments set HOST=0.0.0.0 (see Dockerfile).
if (process.argv[1] === fileURLToPath(import.meta.url)) { const port = Number(process.env.PORT || 3086); const host = process.env.HOST || '127.0.0.1'; createServer().listen(port,host,()=>console.log(JSON.stringify({time:new Date().toISOString(), event:'started', url:`http://${host}:${port}`, commit:process.env.RENDER_GIT_COMMIT || 'local'}))); }
