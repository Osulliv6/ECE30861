import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, resolve, sep } from 'node:path';
import { analyze, EngineError } from './engine/index.mjs';
import { parseUpload, ParserError } from './accessibility-parser/integration.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(moduleDir, 'frontend');
export const MAX_FILE_SIZE_BYTES = 10_000_000;
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json'};

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff', ...headers});
  res.end(JSON.stringify(body));
}
function failure(res, status, code, message) { sendJson(res, status, {error:{code,message}}); }
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

function readBody(req, maxBytes) { return new Promise((resolveBody,reject) => { let size = 0; const chunks = []; req.on('data',chunk => { size += chunk.length; if (size > maxBytes) { reject(Object.assign(new Error('too large'),{code:'FILE_TOO_LARGE'})); req.destroy(); return; } chunks.push(chunk); }); req.on('end',()=>resolveBody(Buffer.concat(chunks))); req.on('error',reject); }); }
function parseMultipart(body, contentType) {
  const found = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType), boundary = found?.[1] || found?.[2]; if (!boundary) throw new Error('Missing multipart boundary.');
  const marker = Buffer.from(`--${boundary}`), parts = []; let cursor = body.indexOf(marker);
  while (cursor >= 0) { const next = body.indexOf(marker,cursor + marker.length); if (next < 0) break; let part = body.subarray(cursor + marker.length,next); if (part.subarray(0,2).equals(Buffer.from('\r\n'))) part = part.subarray(2); if (part.subarray(-2).equals(Buffer.from('\r\n'))) part = part.subarray(0,-2); const split = part.indexOf(Buffer.from('\r\n\r\n')); if (split >= 0) { const headers = part.subarray(0,split).toString('latin1'), disposition = /content-disposition:\s*form-data;[^\r\n]*/i.exec(headers)?.[0] || '', name = /\bname="([^"]+)"/i.exec(disposition)?.[1]; if (name) parts.push({name,filename:/\bfilename="([^"]*)"/i.exec(disposition)?.[1],contentType:/content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.toLowerCase(),data:part.subarray(split + 4)}); } cursor = next; }
  return parts;
}
function setCors(req,res,origins) { const origin = req.headers.origin; if (origin && (origins === '*' || origins.includes(origin))) { res.setHeader('Access-Control-Allow-Origin',origin); res.setHeader('Vary','Origin'); } }
async function serveStatic(req,res) { try { const path = decodeURIComponent(new URL(req.url,'http://localhost').pathname), file = resolve(frontendRoot,'.' + (path === '/' ? '/index.html' : path)); if (!file.startsWith(frontendRoot + sep)) return false; const data = await readFile(file); res.writeHead(200,{'Content-Type':mime[extname(file)] || 'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(req.method === 'HEAD' ? undefined : data); return true; } catch { return false; } }

async function analyzeRequest(req, res, parserOptions) {
  if (Number(req.headers['content-length']) > MAX_FILE_SIZE_BYTES + 16_384) return failure(res,413,'FILE_TOO_LARGE','The file exceeds the 10 MB service limit.');
  if (!req.headers['content-type']?.toLowerCase().startsWith('multipart/form-data')) return failure(res,400,'MALFORMED_REQUEST','Submit one file as multipart/form-data.');
  try {
    const parts = parseMultipart(await readBody(req,MAX_FILE_SIZE_BYTES + 16_384),req.headers['content-type']);
    const file = parts.find(part=>part.name === 'file' && part.filename !== undefined), level = parts.find(part=>part.name === 'wcag_level')?.data.toString('utf8') || 'AA';
    if (!file) return failure(res,400,'MISSING_FILE','Submit one file in the "file" field.');
    if (!file.data.length) return failure(res,422,'UNPROCESSABLE_FILE','The file is empty.');
    if (file.data.length > MAX_FILE_SIZE_BYTES) return failure(res,413,'FILE_TOO_LARGE','The file exceeds the 10 MB service limit.');
    const type = uploadType(file);
    if (!type) return failure(res,415,'UNSUPPORTED_MEDIA_TYPE','Supported formats are HTML, PDF, DOCX, and plain text.');
    if (!['A','AA'].includes(level)) return failure(res,400,'INVALID_WCAG_LEVEL','wcag_level must be "A" or "AA".');
    if (!FORMATS[type].matches(file.data)) return failure(res,422,'UNPROCESSABLE_FILE','The file is corrupt or does not match its file type.');
    return sendJson(res,200,analyze(await parseUpload(file.data,FORMATS[type].ext,parserOptions),{wcagLevel:level}));
  } catch (error) {
    if (error?.code === 'FILE_TOO_LARGE') return failure(res,413,'FILE_TOO_LARGE','The file exceeds the 10 MB service limit.');
    if (error instanceof ParserError) return failure(res,error.status,error.code,error.message);
    if (error instanceof EngineError) return failure(res,503,'PROCESSING_UNAVAILABLE','The file could not be evaluated.');
    return failure(res,400,'MALFORMED_REQUEST','The upload could not be read.');
  }
}

// parserOptions: {python, timeoutMs, tmpRoot} for the Python parser bridge (defaults suit production).
export function createServer({allowedOrigins = (process.env.CORS_ORIGINS || 'http://127.0.0.1:3086,http://localhost:3086').split(','), parserOptions = {}} = {}) {
  return http.createServer(async (req,res) => {
    setCors(req,res,allowedOrigins);
    if (req.method === 'OPTIONS') { res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'}); return res.end(); }
    const path = new URL(req.url,'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') return sendJson(res,200,{status:'ok'});
    if (req.method === 'GET' && path === '/formats') return sendJson(res,200,{supported_mime_types:SUPPORTED_MIME_TYPES,max_file_size_mb:10});
    if (req.method === 'POST' && path === '/analyze') return analyzeRequest(req,res,parserOptions);
    if (['GET','HEAD'].includes(req.method) && await serveStatic(req,res)) return;
    failure(res,404,'NOT_FOUND','Endpoint not found.');
  });
}
// HOST defaults to loopback for local use; deployments set HOST=0.0.0.0 (see Dockerfile).
if (process.argv[1] === fileURLToPath(import.meta.url)) { const port = Number(process.env.PORT || 3086); const host = process.env.HOST || '127.0.0.1'; createServer().listen(port,host,()=>console.log(`Accessibility service: http://${host}:${port}`)); }
