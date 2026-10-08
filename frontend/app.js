import { API_BASE_URL, REQUEST_TIMEOUT_MS } from './config.js';
import { ApiError, normalizeBaseUrl, parseFormats, acceptedTypes, validateFile, parseReport, requestJson, describeLocation } from './core.js';
import { sampleIssues, sampleClean } from './samples.js';
const $ = id => document.getElementById(id);
const state = {base:API_BASE_URL,formats:null,file:null,report:null,busy:false,controller:null,connectionController:null,requestId:0,sample:false,documentName:'',level:'AA',interval:null};
function announce(message) { $('announcer').textContent = message; }
function showError(element,error) { element.textContent = error.message || String(error); element.hidden = false; }
function notice(error) {
  $('notice').replaceChildren();
  const title=document.createElement('strong'); title.textContent = error.code === 'PROCESSING_PENDING' ? 'Report not yet available' : 'Check could not be completed';
  const body=document.createElement('span'); body.textContent=error.message;
  $('notice').append(title,body); $('notice').hidden=false; announce(error.message);
}
function clearReport() { state.report=null;state.sample=false;$('report').hidden=true;$('export-button').hidden=true;$('empty-state').hidden=false;$('notice').hidden=true;$('findings').replaceChildren(); }
function refreshButton() {
  $('analyze-button').disabled=state.busy || !state.formats || !state.file;
  $('action-hint').textContent=state.busy?'Your document is being processed.':!state.formats?'Connect the analysis service to start a check.':!state.file?'Choose a supported document to start.':'Ready to check. Suggested fixes will appear in the report.';
}
function setBusy(busy) {
  state.busy=busy;
  $('progress').hidden=!busy;
  document.querySelector('.results-section').setAttribute('aria-busy',String(busy));
  $('cancel-button').hidden=!busy;$('analyze-button').hidden=busy;
  ['file-input','remove-file','wcag-level','sample-issues','sample-clean','connect'].forEach(id=>$(id).disabled=busy);
  $('drop-zone').style.pointerEvents=busy?'none':'';
  if(busy) {
    $('empty-state').hidden=true;const start=Date.now();$('elapsed').textContent='0 seconds elapsed';
    state.interval=setInterval(()=>$('elapsed').textContent=`${Math.floor((Date.now()-start)/1000)} seconds elapsed`,1000);
  } else { clearInterval(state.interval);refreshButton(); }
}
function chooseFile(file) {
  if(state.busy) return;
  clearReport();$('file-error').hidden=true;state.file=null;$('file-summary').hidden=true;
  if(!state.formats){showError($('file-error'),new Error('Connect the service before choosing a document.'));$('file-input').value='';refreshButton();return;}
  try {
    validateFile(file,state.formats);state.file=file;
    $('file-name').textContent=file.name;$('file-meta').textContent=file.size<1_000_000?`${(file.size/1000).toFixed(1)} KB`:`${(file.size/1_000_000).toFixed(2)} MB`;
    $('file-summary').hidden=false;announce(`${file.name} selected.`);
  } catch(e){showError($('file-error'),e);$('file-input').value='';announce(e.message);}
  refreshButton();
}
$('file-input').addEventListener('change',()=>chooseFile($('file-input').files[0]));
$('remove-file').addEventListener('click',()=>{state.file=null;$('file-input').value='';$('file-summary').hidden=true;$('file-error').hidden=true;clearReport();refreshButton();$('file-input').focus();});
for (const type of ['dragenter','dragover']) $('drop-zone').addEventListener(type,e=>{e.preventDefault();if(!state.busy)$('drop-zone').classList.add('dragging');});
for (const type of ['dragleave','drop']) $('drop-zone').addEventListener(type,e=>{e.preventDefault();$('drop-zone').classList.remove('dragging');});
$('drop-zone').addEventListener('drop',e=>{
  if(state.busy)return;
  if(e.dataTransfer.files.length!==1){showError($('file-error'),new Error('Choose one document at a time.'));announce('Choose one document at a time.');return;}
  $('file-input').value='';chooseFile(e.dataTransfer.files[0]);
});
// Prevent accidentally navigating to a dropped document outside the upload target.
window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());
function addText(parent,tag,className,text) { const el=document.createElement(tag);el.className=className;el.textContent=text;parent.append(el);return el; }
function renderFindings() {
  const filter=$('severity-filter').value;
  const issues=state.report.issues.filter(x=>filter==='all' || x.severity===filter);
  $('findings').replaceChildren();$('filter-count').textContent=`${issues.length} of ${state.report.issues.length}`;
  if(!issues.length && state.report.issues.length) addText($('findings'),'p','no-findings','No findings match this severity. Choose All findings to see the complete report.');
  for(const issue of issues){
    const article=document.createElement('article');article.className='finding';
    const meta=document.createElement('div');meta.className='finding-meta';
    addText(meta,'span',`severity ${issue.severity}`,issue.severity);
    addText(meta,'span','criterion',`WCAG ${issue.wcag_criterion}`);article.append(meta);
    addText(article,'h4','',issue.description);
    addText(article,'p','location',describeLocation(issue.location).join('\n'));
    addText(article,'p','fix-label','Suggested fix');addText(article,'p','fix',issue.suggested_fix);
    $('findings').append(article);
  }
}
function renderReport(report,{sample=false,name=state.documentName,level=state.level}={}){
  state.report=report;state.sample=sample;state.documentName=name;state.level=level;
  $('empty-state').hidden=true;$('notice').hidden=true;$('report').hidden=false;$('export-button').hidden=false;
  $('sample-banner').hidden=!sample;$('sample-reset').hidden=!sample;
  $('report-label').textContent=sample?'EXAMPLE REVIEW':'COMPLETED REVIEW';
  const n=report.issues.length;
  $('report-title').textContent=n?`${n} ${n===1?'finding':'findings'} to review`:'No supported violations detected';
  $('issue-count').textContent=n;$('report-document').textContent=`${name} · WCAG 2.1 ${level}`;
  const message = n === 0 ? 'No supported violations were detected within the checks performed. This does not certify full ADA or WCAG compliance.' : report.message;
  $('report-message').hidden=!message;$('report-message').textContent=typeof message==='string'?message:'';
  $('filter-bar').hidden=n===0;$('severity-filter').value='all';renderFindings();
  announce(`${sample?'Sample report. ':''}${n?`${n} findings to review.`:'No supported violations detected. This does not certify full compliance.'}`);
  $('report-title').focus();
}
$('severity-filter').addEventListener('change',()=>{renderFindings();announce($('filter-count').textContent+' findings shown.');});
$('sample-issues').addEventListener('click',()=>renderReport(sampleIssues,{sample:true,name:'Example course handout.pdf',level:'AA'}));
$('sample-clean').addEventListener('click',()=>renderReport(sampleClean,{sample:true,name:'Example course handout.pdf',level:'AA'}));
$('sample-reset').addEventListener('click',()=>{clearReport();$('sample-issues').focus();});
$('wcag-level').addEventListener('change',()=>{clearReport();});
$('analyze-form').addEventListener('submit',async e=>{
  e.preventDefault();if(state.busy)return;$('file-error').hidden=true;
  try { if(!state.formats)throw new ApiError('Connect the service before starting a check.');validateFile(state.file,state.formats); } catch(error){showError($('file-error'),error);return;}
  clearReport();state.documentName=state.file.name;state.level=$('wcag-level').value;
  const body=new FormData();body.append('file',state.file,state.file.name);body.append('wcag_level',state.level);
  const id=++state.requestId;state.controller=new AbortController();setBusy(true);announce('Check started. Waiting for the service.');
  try {
    const data=await requestJson(state.base,'/analyze',{method:'POST',body,signal:state.controller.signal,timeoutMs:REQUEST_TIMEOUT_MS});
    if(id!==state.requestId)return;
    const report=parseReport(data);setBusy(false);state.controller=null;
    // Release the selected upload; reports remain only in page memory.
    state.file=null;$('file-input').value='';$('file-summary').hidden=true;refreshButton();renderReport(report);
  } catch(error){if(id!==state.requestId)return;setBusy(false);state.controller=null;notice(error);$('analyze-button').focus();}
});
$('cancel-button').addEventListener('click',()=>{
  state.requestId++;state.controller?.abort();state.controller=null;setBusy(false);
  notice(new ApiError('The check was canceled in this browser. No completed report is available.','REQUEST_CANCELED'));$('analyze-button').focus();
});
$('export-button').addEventListener('click',()=>{
  if(!state.report)return;
  const data={...state.report,frontend_context:{document_name:state.documentName,wcag_level:state.level,sample:state.sample,scope_note:'Only supported checks were evaluated; this report does not certify full ADA or WCAG compliance.'}};
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=state.sample?'sample-accessibility-report.json':'accessibility-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);announce('JSON report downloaded.');
});
async function connect(base,{silent=false}={}){
  state.connectionController?.abort();const controller=new AbortController();state.connectionController=controller;
  $('save-connection').disabled=true;$('connection-error').hidden=true;$('connection-label').textContent='Connecting…';
  try {
    base=normalizeBaseUrl(base);
    const [health,rawFormats]=await Promise.all([
      requestJson(base,'/health',{signal:controller.signal,timeoutMs:8000}),
      requestJson(base,'/formats',{signal:controller.signal,timeoutMs:8000})
    ]);
    if(state.connectionController!==controller)return;
    if(health.status!=='ok')throw new ApiError('The service health check did not return status ok.','INVALID_RESPONSE');
    const formats=parseFormats(rawFormats);state.base=base;state.formats=formats;
    $('connection-dot').classList.add('ready');$('connection-label').textContent='Service connected';
    $('file-input').accept=acceptedTypes(formats);
    const names=formats.supported_mime_types.map(m=>{const ext=acceptedTypes({supported_mime_types:[m]}).split(',').filter(v=>v.startsWith('.'));return ext.length?ext.join(' / '):m;});
    $('formats-hint').textContent=`${names.join(', ')} · Up to ${formats.max_file_size_mb} MB`;
    if(state.file){try{validateFile(state.file,formats);}catch{state.file=null;$('file-input').value='';$('file-summary').hidden=true;}}
    clearReport();refreshButton();$('connection-dialog').close();announce('Analysis service connected. Choose a document to begin.');
  } catch(error){
    if(state.connectionController!==controller)return;
    // Keep an existing connection if switching to another service fails.
    $('connection-label').textContent=state.formats?'Service connected':'Connect service';
    if(!silent)showError($('connection-error'),error);
    refreshButton();
  } finally {if(state.connectionController===controller){state.connectionController=null;$('save-connection').disabled=false;}}
}
$('connect').addEventListener('click',()=>{$('api-url').value=state.base;$('connection-error').hidden=true;$('connection-dialog').showModal();});
function closeConnection(){state.connectionController?.abort();state.connectionController=null;$('save-connection').disabled=false;$('connection-label').textContent=state.formats?'Service connected':'Connect service';$('connection-dialog').close();}
$('close-dialog').addEventListener('click',closeConnection);
$('connection-dialog').addEventListener('cancel',e=>{e.preventDefault();closeConnection();});
$('connection-form').addEventListener('submit',e=>{e.preventDefault();connect($('api-url').value);});
refreshButton();connect(API_BASE_URL,{silent:true});
