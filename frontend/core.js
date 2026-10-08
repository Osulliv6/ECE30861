export const SEVERITIES = ['critical','serious','moderate','minor'];
export class ApiError extends Error {
  constructor(message, code = 'REQUEST_FAILED', status = 0) { super(message); this.name = 'ApiError'; this.code = code; this.status = status; }
}
export const MIME_EXTENSIONS = {
  'application/pdf':['.pdf'],
  'application/msword':['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':['.docx'],
  'application/vnd.ms-powerpoint':['.ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':['.pptx'],
  'application/vnd.ms-excel':['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['.xlsx'],
  'text/html':['.html','.htm'], 'application/xhtml+xml':['.xhtml'], 'text/plain':['.txt'],
  'text/markdown':['.md'], 'text/x-tex':['.tex'], 'application/x-tex':['.tex'], 'image/png':['.png'], 'image/jpeg':['.jpg','.jpeg'], 'image/svg+xml':['.svg']
};
export function normalizeBaseUrl(value) {
  const v = value.trim().replace(/\/+$/, '');
  if (!v) return '';
  let u; try { u = new URL(v); } catch { throw new ApiError('Enter a complete service URL.', 'INVALID_URL'); }
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new ApiError('Use HTTPS for the deployed service. HTTP is allowed only on localhost.', 'INSECURE_URL');
  if (u.username || u.password || u.search || u.hash) throw new ApiError('Use a base URL without credentials, a query, or a fragment.', 'INVALID_URL');
  return v;
}
export function parseFormats(data) {
  if (!data || !Array.isArray(data.supported_mime_types) || !data.supported_mime_types.length || data.supported_mime_types.some(x=>typeof x !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(x)) || !Number.isFinite(data.max_file_size_mb) || data.max_file_size_mb < 10) throw new ApiError('The service returned an invalid supported-formats response.', 'INVALID_RESPONSE');
  return {supported_mime_types:[...new Set(data.supported_mime_types)],max_file_size_mb:data.max_file_size_mb};
}
export function acceptedTypes(formats) { return [...new Set(formats.supported_mime_types.flatMap(m=>[m,...(MIME_EXTENSIONS[m] || [])]))].join(','); }
export function validateFile(file, formats) {
  if (!file) throw new ApiError('Choose a file before starting a check.', 'MISSING_FILE');
  if (!file.size) throw new ApiError('This file is empty. Choose a document with content.', 'UNPROCESSABLE_FILE', 422);
  if (file.size > formats.max_file_size_mb * 1_000_000) throw new ApiError(`This file exceeds the ${formats.max_file_size_mb} MB limit. Choose a smaller document.`, 'FILE_TOO_LARGE', 413);
  const extension = '.' + file.name.split('.').pop().toLowerCase();
  // Browsers can omit or misidentify MIME types. An advertised extension is a hint;
  // the backend remains responsible for content-based validation and corruption.
  if (!formats.supported_mime_types.includes(file.type) && !formats.supported_mime_types.some(m=>(MIME_EXTENSIONS[m] || []).includes(extension))) throw new ApiError('This file type is not supported by the connected service.', 'UNSUPPORTED_MEDIA_TYPE', 415);
  return file;
}
export function parseReport(data) {
  if (!data || data.error || !Array.isArray(data.issues)) throw new ApiError('The service did not return a complete accessibility report.', 'INVALID_RESPONSE');
  if (!data.issues.length && (typeof data.message !== 'string' || !data.message.trim())) throw new ApiError('The service returned a no-issue report without the required message.', 'INVALID_RESPONSE');
  for (const issue of data.issues) {
    if (!issue || typeof issue.wcag_criterion !== 'string' || !/^\d+\.\d+\.\d+$/.test(issue.wcag_criterion) || !SEVERITIES.includes(issue.severity) || typeof issue.description !== 'string' || !issue.description.trim() || typeof issue.suggested_fix !== 'string' || !issue.suggested_fix.trim() || !Object.hasOwn(issue,'location')) throw new ApiError('A finding is missing required report fields. No results have been displayed.', 'INVALID_RESPONSE');
    const l = issue.location;
    if (l !== null && (typeof l !== 'object' || Array.isArray(l) || !['selector','line','page','snippet'].some(k=>Object.hasOwn(l,k)) || ['selector','snippet'].some(k=>Object.hasOwn(l,k) && typeof l[k] !== 'string') || ['line','page'].some(k=>Object.hasOwn(l,k) && (!Number.isInteger(l[k]) || l[k]<1)))) throw new ApiError('A finding has an invalid location.', 'INVALID_RESPONSE');
  }
  return data;
}
const HTTP_ERRORS = {400:'The request could not be accepted.',413:'The file exceeds the service’s size limit.',415:'The service does not support this file type.',422:'The file is empty, corrupt, or unreadable and could not be evaluated.',503:'The analysis service or a required AI service is temporarily unavailable. Please try again.'};
export async function requestJson(base, path, {fetchImpl = globalThis.fetch, timeoutMs = 30_000, signal, ...options} = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = ()=>controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
  const timer = setTimeout(()=>{timedOut=true; controller.abort();},timeoutMs);
  try {
    const response = await fetchImpl(base + path,{...options,signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error'});
    let data; try { data = await response.json(); } catch { throw new ApiError(HTTP_ERRORS[response.status] || 'The service returned an unreadable response. Check the service connection.', 'INVALID_RESPONSE', response.status); }
    if (!response.ok || data?.error) {
      const e = data?.error || data || {};
      throw new ApiError(e.message || HTTP_ERRORS[response.status] || 'The service could not complete this request.',e.code || 'REQUEST_FAILED',response.status);
    }
    if (response.status === 202) throw new ApiError('The service is still processing this document. A completed report is not available yet.', 'PROCESSING_PENDING',202);
    return data;
  } catch (e) {
    if (timedOut) throw new ApiError(`No complete response arrived within ${timeoutMs / 1000} seconds. The request has stopped; try again when the service is available.`, 'REQUEST_TIMEOUT');
    if (controller.signal.aborted) throw new ApiError('The check was canceled. No completed report is available.', 'REQUEST_CANCELED');
    if (e instanceof ApiError) throw e;
    throw new ApiError('Could not reach the service. Check its URL, network connection, and cross-origin access settings.', 'NETWORK_ERROR');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
}
export function describeLocation(location) {
  if (location === null) return ['Location not identified'];
  const parts=[];
  if (location.page) parts.push(`Page ${location.page}`);
  if (location.line) parts.push(`Line ${location.line}`);
  if (location.selector) parts.push(`Element: ${location.selector}`);
  if (location.snippet) parts.push(`Content: ${location.snippet}`);
  return parts;
}
