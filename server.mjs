import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, resolve, sep } from 'node:path';
import { analyze, EngineError } from './engine/index.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(moduleDir, 'frontend');
export const MAX_FILE_SIZE_BYTES = 10_000_000;
export const SUPPORTED_MIME_TYPES = ['text/html'];
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json'};

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff', ...headers});
  res.end(JSON.stringify(body));
}
function failure(res, status, code, message) { sendJson(res, status, {error:{code,message}}); }
function lineAt(text, offset) { return text.slice(0, offset).split('\n').length; }
function attributes(tag) {
  const out = {};
  const tagName = tag.match(/^<\s*\/?\s*([^\s/>]+)/)?.[1]?.toLowerCase();
  for (const match of tag.matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) if (match[1].toLowerCase() !== tagName) out[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  return out;
}
function textOnly(value) { return value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim(); }

// This deliberately extracts only semantic data for the deterministic engine; input is never rendered.
export function parseHtmlDocument(bytes) {
  let html;
  try { html = new TextDecoder('utf-8', {fatal:true}).decode(bytes); } catch { throw new Error('The HTML file is not valid UTF-8.'); }
  if (!html.trim() || !/<(?:!doctype\s+html|html[\s>])/i.test(html)) throw new Error('The uploaded file is not a complete HTML document.');
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] || '';
  const title = textOnly(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '');
  const elements = [], location = offset => ({line:lineAt(html, offset)});
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) { const a = attributes(match[0]); elements.push({type:'image',alt:Object.hasOwn(a,'alt') ? a.alt : null,decorative:a.role === 'presentation' || a['aria-hidden'] === 'true',src:a.src,location:location(match.index)}); }
  for (const match of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) elements.push({type:'heading',level:Number(match[1]),text:textOnly(match[2]),location:location(match.index)});
  for (const match of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)) { const open = match[0].match(/^<a\b[^>]*>/i)?.[0] || ''; elements.push({type:'link',text:textOnly(match[1]),href:attributes(open).href,location:location(match.index)}); }
  for (const match of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) { const body = match[1]; elements.push({type:'table',rows:(body.match(/<tr\b/gi) || []).length,has_header_row:/<th\b/i.test(body),has_header_column:false,location:location(match.index)}); }
  for (const match of html.matchAll(/<(p|div|li|span)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
    const text = textOnly(match[3]); if (!text) continue;
    const a = attributes(`<${match[1]} ${match[2]}>`), style = a.style || '';
    elements.push({type:'text',text,bold:/font-weight\s*:\s*(bold|[6-9]00)/i.test(style) || /<\s*(b|strong)\b/i.test(match[3]),standalone:['p','div','li'].includes(match[1].toLowerCase()),color:style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)?.[1]?.trim(),background:style.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i)?.[1]?.trim(),location:location(match.index)});
  }
  return {metadata:{title,language:attributes(htmlTag).lang || ''},elements};
}

function readBody(req, maxBytes) { return new Promise((resolveBody,reject) => { let size = 0; const chunks = []; req.on('data',chunk => { size += chunk.length; if (size > maxBytes) { reject(Object.assign(new Error('too large'),{code:'FILE_TOO_LARGE'})); req.destroy(); return; } chunks.push(chunk); }); req.on('end',()=>resolveBody(Buffer.concat(chunks))); req.on('error',reject); }); }
function parseMultipart(body, contentType) {
  const found = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType), boundary = found?.[1] || found?.[2]; if (!boundary) throw new Error('Missing multipart boundary.');
  const marker = Buffer.from(`--${boundary}`), parts = []; let cursor = body.indexOf(marker);
  while (cursor >= 0) { const next = body.indexOf(marker,cursor + marker.length); if (next < 0) break; let part = body.subarray(cursor + marker.length,next); if (part.subarray(0,2).equals(Buffer.from('\r\n'))) part = part.subarray(2); if (part.subarray(-2).equals(Buffer.from('\r\n'))) part = part.subarray(0,-2); const split = part.indexOf(Buffer.from('\r\n\r\n')); if (split >= 0) { const headers = part.subarray(0,split).toString('latin1'), disposition = /content-disposition:\s*form-data;[^\r\n]*/i.exec(headers)?.[0] || '', name = /\bname="([^"]+)"/i.exec(disposition)?.[1]; if (name) parts.push({name,filename:/\bfilename="([^"]*)"/i.exec(disposition)?.[1],contentType:/content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.toLowerCase(),data:part.subarray(split + 4)}); } cursor = next; }
  return parts;
}
function setCors(req,res,origins) { const origin = req.headers.origin; if (origin && (origins === '*' || origins.includes(origin))) { res.setHeader('Access-Control-Allow-Origin',origin); res.setHeader('Vary','Origin'); } }
async function serveStatic(req,res) { const path = decodeURIComponent(new URL(req.url,'http://localhost').pathname), file = resolve(frontendRoot,'.' + (path === '/' ? '/index.html' : path)); if (!file.startsWith(frontendRoot + sep)) return false; try { const data = await readFile(file); res.writeHead(200,{'Content-Type':mime[extname(file)] || 'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(req.method === 'HEAD' ? undefined : data); return true; } catch { return false; } }

export function createServer({allowedOrigins = (process.env.CORS_ORIGINS || 'http://127.0.0.1:3086,http://localhost:3086').split(',')} = {}) {
  return http.createServer(async (req,res) => {
    setCors(req,res,allowedOrigins);
    if (req.method === 'OPTIONS') { res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'}); return res.end(); }
    const path = new URL(req.url,'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') return sendJson(res,200,{status:'ok'});
    if (req.method === 'GET' && path === '/formats') return sendJson(res,200,{supported_mime_types:SUPPORTED_MIME_TYPES,max_file_size_mb:10});
    if (req.method === 'POST' && path === '/analyze') {
      if (Number(req.headers['content-length']) > MAX_FILE_SIZE_BYTES + 16_384) return failure(res,413,'FILE_TOO_LARGE','The file exceeds the 10 MB service limit.');
      if (!req.headers['content-type']?.toLowerCase().startsWith('multipart/form-data')) return failure(res,400,'MALFORMED_REQUEST','Submit one file as multipart/form-data.');
      try { const parts = parseMultipart(await readBody(req,MAX_FILE_SIZE_BYTES + 16_384),req.headers['content-type']), file = parts.find(part=>part.name === 'file' && part.filename !== undefined), level = parts.find(part=>part.name === 'wcag_level')?.data.toString('utf8') || 'AA'; if (!file) return failure(res,400,'MISSING_FILE','Submit one file in the "file" field.'); if (!file.data.length) return failure(res,422,'UNPROCESSABLE_FILE','The file could not be evaluated.'); if (file.data.length > MAX_FILE_SIZE_BYTES) return failure(res,413,'FILE_TOO_LARGE','The file exceeds the 10 MB service limit.'); if (!SUPPORTED_MIME_TYPES.includes(file.contentType || '')) return failure(res,415,'UNSUPPORTED_MEDIA_TYPE','Only HTML documents are supported in this phase.'); if (!['A','AA'].includes(level)) return failure(res,400,'INVALID_WCAG_LEVEL','wcag_level must be "A" or "AA".'); return sendJson(res,200,analyze(parseHtmlDocument(file.data),{wcagLevel:level})); }
      catch (error) { if (error?.code === 'FILE_TOO_LARGE') return failure(res,413,'FILE_TOO_LARGE','The file exceeds the 10 MB service limit.'); if (error instanceof EngineError) return failure(res,503,'PROCESSING_UNAVAILABLE','The file could not be evaluated.'); return failure(res,422,'UNPROCESSABLE_FILE','The file could not be evaluated.'); }
    }
    if (['GET','HEAD'].includes(req.method) && await serveStatic(req,res)) return;
    failure(res,404,'NOT_FOUND','Endpoint not found.');
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { const port = Number(process.env.PORT || 3086); createServer().listen(port,'127.0.0.1',()=>console.log(`Accessibility service: http://127.0.0.1:${port}`)); }
