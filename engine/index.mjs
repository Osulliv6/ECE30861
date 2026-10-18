// Accessibility analysis / WCAG engine.
// Input: a parsed document (see README "Accessibility engine" for the format).
// Output: the shared report contract consumed by the frontend: {issues:[...], message?}.
import { checkAltText, checkHeadings, checkContrast, checkLinks, checkTables, checkMetadata } from './checks.mjs';

export class EngineError extends Error {
  constructor(message, code = 'INVALID_PARSED_DOCUMENT') { super(message); this.name = 'EngineError'; this.code = code; }
}

// Every criterion the engine can report, with its WCAG 2.1 conformance level.
export const SUPPORTED_CRITERIA = {
  '1.1.1':{name:'Non-text Content',level:'A'},
  '1.3.1':{name:'Info and Relationships',level:'A'},
  '1.4.3':{name:'Contrast (Minimum)',level:'AA'},
  '2.4.2':{name:'Page Titled',level:'A'},
  '2.4.4':{name:'Link Purpose (In Context)',level:'A'},
  '2.4.6':{name:'Headings and Labels',level:'AA'},
  '3.1.1':{name:'Language of Page',level:'A'},
};

export const NO_ISSUE_MESSAGE = 'No supported violations were detected. This does not certify full ADA or WCAG compliance.';
const CHECKS = [checkMetadata, checkAltText, checkHeadings, checkContrast, checkLinks, checkTables];
const LEVELS = ['A','AA'];

export function validateParsedDocument(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new EngineError('The parsed document must be an object.');
  if (!Array.isArray(doc.elements)) throw new EngineError('The parsed document must include an "elements" array.');
  if (doc.metadata !== undefined && doc.metadata !== null && (typeof doc.metadata !== 'object' || Array.isArray(doc.metadata))) throw new EngineError('"metadata" must be an object when provided.');
  const notExtracted = doc.metadata?.not_extracted;
  if (notExtracted !== undefined && !(Array.isArray(notExtracted) && notExtracted.every(v=>typeof v === 'string'))) throw new EngineError('"metadata.not_extracted" must be an array of strings when provided.');
  doc.elements.forEach((el,i)=>{
    if (!el || typeof el !== 'object' || typeof el.type !== 'string') throw new EngineError(`Element ${i} must be an object with a string "type".`);
    if (el.type === 'heading' && !(Number.isInteger(el.level) && el.level >= 1 && el.level <= 6)) throw new EngineError(`Heading element ${i} must have an integer "level" from 1 to 6.`);
    if (el.location !== undefined && el.location !== null && (typeof el.location !== 'object' || Array.isArray(el.location))) throw new EngineError(`Element ${i} has an invalid "location".`);
  });
  return doc;
}

// Returns a report for the given WCAG level ("A" or "AA"; AA includes A).
export function analyze(doc, {wcagLevel = 'AA'} = {}) {
  if (!LEVELS.includes(wcagLevel)) throw new EngineError('wcag_level must be "A" or "AA".','INVALID_WCAG_LEVEL');
  validateParsedDocument(doc);
  const allowed = LEVELS.slice(0, LEVELS.indexOf(wcagLevel) + 1);
  const issues = CHECKS.flatMap(check=>check(doc))
    .filter(issue=>allowed.includes(SUPPORTED_CRITERIA[issue.wcag_criterion].level))
    .map((issue,i)=>({issue,i}))
    // Document-level findings (no location) first, then reading order by page and line.
    .sort((a,b)=>(a.issue.location?.page ?? 0)-(b.issue.location?.page ?? 0) || (a.issue.location?.line ?? 0)-(b.issue.location?.line ?? 0) || a.i-b.i)
    .map(({issue})=>issue);
  return issues.length ? {issues} : {issues, message:NO_ISSUE_MESSAGE};
}
