import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyze,EngineError,NO_ISSUE_MESSAGE,SUPPORTED_CRITERIA } from '../engine/index.mjs';
import { parseColor,contrastRatio,isLargeText } from '../engine/contrast.mjs';
import { parseReport } from '../frontend/core.js';
const meta={title:'Syllabus',language:'en'};
const run=(elements,opts)=>analyze({metadata:meta,elements},opts);
const criteria=r=>r.issues.map(i=>i.wcag_criterion);
const syllabus=JSON.parse(await readFile(new URL('./fixtures/parsed/syllabus.json',import.meta.url),'utf8'));

test('reports satisfy the frontend report contract, including the no-issue message',()=>{
  const report=analyze(syllabus);
  assert.equal(parseReport(report),report);
  assert.deepEqual(criteria(report),['2.4.2','1.3.1','1.4.3','1.1.1','1.1.1','1.3.1','2.4.4','1.3.1']);
  const clean=run([{type:'heading',level:1,text:'Title'},{type:'image',alt:'Bar chart of weekly attendance'}]);
  assert.deepEqual(clean,{issues:[],message:NO_ISSUE_MESSAGE});assert.equal(parseReport(clean),clean);
});
test('alt text: missing, placeholder, file name, redundant and long; decorative images are skipped',()=>{
  const r=run([{type:'image'},{type:'image',alt:'image'},{type:'image',alt:'scan 3.JPG'},{type:'image',alt:'Picture of a circuit'},{type:'image',alt:'x'.repeat(151)},{type:'image',alt:''},{type:'image',decorative:true},{type:'image',alt:'Circuit with two resistors in series'}]);
  assert.deepEqual(r.issues.map(i=>i.severity),['serious','serious','serious','minor','minor']);
  assert.ok(r.issues.every(i=>i.wcag_criterion==='1.1.1'));
});
test('heading structure: skipped levels, non-H1 start, empty headings, fake headings, missing headings',()=>{
  const r=run([{type:'heading',level:2,text:'Intro'},{type:'heading',level:4,text:'Deep'},{type:'heading',level:5,text:''},{type:'heading',level:2,text:'Back up'},{type:'text',text:'Office Hours',bold:true,standalone:true},{type:'text',text:'A normal bold sentence.',bold:true,standalone:true}]);
  assert.deepEqual(r.issues.map(i=>[i.wcag_criterion,i.description]),[
    ['1.3.1','The first heading is level 2 rather than level 1.'],['1.3.1','Heading levels skip from 2 to 4.'],['2.4.6','A heading is empty.'],
    ['1.3.1','Text appears to be a section title but uses visual formatting instead of a semantic heading.']]);
  assert.deepEqual(criteria(run([{type:'text',text:'word '.repeat(400)}])),['1.3.1']);
  assert.throws(()=>run([{type:'heading',level:7,text:'x'}]),EngineError);
});
test('contrast math matches WCAG reference values and large-text thresholds',()=>{
  assert.equal(contrastRatio(parseColor('#000'),parseColor('white')).toFixed(1),'21.0');
  assert.equal(contrastRatio(parseColor('rgb(118,118,118)'),parseColor('#fff')).toFixed(2),'4.54');
  assert.equal(parseColor('not-a-color'),null);
  assert.ok(isLargeText({font_size_pt:18}) && isLargeText({font_size_pt:14,bold:true}) && !isLargeText({font_size_pt:14}));
  const grey={type:'text',text:'Due Friday at noon.',color:'#949494'}; // ~3.03:1 on white
  assert.deepEqual(criteria(run([grey])),['1.4.3']);
  assert.deepEqual(criteria(run([{...grey,font_size_pt:18}])),[]);
  assert.deepEqual(criteria(run([{...grey,color:'#767676'}])),[]);
  assert.equal(run([{...grey,color:'#eeeeee'}]).issues[0].severity,'serious');
  assert.deepEqual(criteria(run([{...grey,color:'teal-ish'}])),[],'unknown colors are not guessed');
});
test('links, tables and metadata',()=>{
  assert.deepEqual(run([{type:'link',text:'',href:'a'},{type:'link',text:'Read more...'},{type:'link',text:'https://x.edu/a'},{type:'link',text:'Lab 3 rubric'}]).issues.map(i=>i.severity),['serious','moderate','minor']);
  assert.deepEqual(criteria(run([{type:'table',rows:4},{type:'table',rows:4,has_header_row:true},{type:'table',rows:4,layout:true},{type:'table',rows:1}])),['1.3.1']);
  assert.deepEqual(criteria(analyze({elements:[]})),['2.4.2','3.1.1']);
  assert.deepEqual(criteria(analyze({metadata:{title:'T',language:'english'},elements:[]})),['3.1.1']);
});
test('WCAG level A excludes AA-only criteria',()=>{
  const levels=new Set(analyze(syllabus,{wcagLevel:'A'}).issues.map(i=>SUPPORTED_CRITERIA[i.wcag_criterion].level));
  assert.deepEqual([...levels],['A']);
  assert.ok(criteria(analyze(syllabus)).includes('1.4.3'));
  assert.throws(()=>analyze(syllabus,{wcagLevel:'AAA'}),e=>e.code==='INVALID_WCAG_LEVEL');
});
test('invalid parser output is rejected; locations stay contract-valid',()=>{
  for(const bad of [null,[],{},{elements:{}},{elements:[{}]},{elements:[{type:'image',location:'p2'}]},{metadata:[],elements:[]}])assert.throws(()=>analyze(bad),e=>e instanceof EngineError && e.code==='INVALID_PARSED_DOCUMENT');
  const r=run([{type:'image',location:{page:0,line:-1,selector:' '}},{type:'link',text:'here',location:{line:12,selector:'#a'}},{type:'link',text:'',location:{}}]);
  assert.deepEqual(r.issues.map(i=>i.location),[{snippet:'Image'},{snippet:'Link'},{line:12,selector:'#a',snippet:'here'}]);
  assert.equal(parseReport(r),r);
});
