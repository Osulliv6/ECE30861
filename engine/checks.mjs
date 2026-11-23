// Individual accessibility checks. Each check receives the validated parsed document
// and returns findings in the shared report shape (see README "Accessibility engine").
import { parseColor, contrastRatio, isLargeText } from './contrast.mjs';

const SNIPPET_MAX = 80;

export function snippet(text) {
  const t = String(text ?? '').replace(/\s+/g,' ').trim();
  return t.length > SNIPPET_MAX ? t.slice(0,SNIPPET_MAX-1) + '…' : t;
}

// Builds a contract-valid location from an element, or null when nothing usable is known.
export function locate(el, text) {
  const src = el?.location || {};
  const loc = {};
  for (const k of ['page','line']) if (Number.isInteger(src[k]) && src[k] >= 1) loc[k] = src[k];
  if (typeof src.selector === 'string' && src.selector.trim()) loc.selector = src.selector.trim();
  const s = snippet(text);
  if (s) loc.snippet = s;
  return Object.keys(loc).length ? loc : null;
}

// The parser lists semantics it could not observe (e.g. PDF alt text). Checks that depend
// on them are skipped, so "unknown" is never reported as "missing".
const notExtracted = (doc, what) => Array.isArray(doc.metadata?.not_extracted) && doc.metadata.not_extracted.includes(what);

const finding = (wcag_criterion, severity, el, text, description, suggested_fix) =>
  ({wcag_criterion, severity, location:locate(el,text), description, suggested_fix});

// ---- 1.1.1 Non-text content -------------------------------------------------------------

const PLACEHOLDER_ALT = /^(image|img|picture|pic|photo|photograph|graphic|figure|fig|icon|logo|chart|diagram|untitled|placeholder|alt|alt text|spacer|\d+)$/i;
const FILENAME_ALT = /^[\w\-. ]+\.(png|jpe?g|gif|bmp|svg|webp|tiff?|emf|wmf)$/i;
const REDUNDANT_ALT = /^(an? )?(image|picture|photo|graphic) of\b/i;
const ALT_LONG = 150;

export function checkAltText(doc) {
  const out = [];
  if (notExtracted(doc,'alt_text')) return out;
  for (const el of doc.elements) {
    if (el.type !== 'image' || el.decorative === true) continue;
    const label = el.caption || el.src || el.alt || 'Image';
    if (el.alt === undefined || el.alt === null) {
      out.push(finding('1.1.1','serious',el,label,
        'An image has no alternative text.',
        doc.metadata?.format === 'pdf'
          ? 'Set alternate text on the Figure tag in a PDF accessibility editor. Describe the information conveyed, or mark a decorative figure as an artifact.'
          : 'Add alternative text that conveys the image’s purpose and the information it provides. If the image is purely decorative, mark it as decorative so assistive technology skips it.'));
      continue;
    }
    const alt = String(el.alt).trim();
    if (!alt) continue; // Empty alt marks the image as decorative.
    if (FILENAME_ALT.test(alt) || PLACEHOLDER_ALT.test(alt)) {
      out.push(finding('1.1.1','serious',el,alt,
        'An image’s alternative text is a file name or placeholder and does not describe the image.',
        'Replace the alternative text with a short description of what the image shows and why it is included.'));
    } else if (REDUNDANT_ALT.test(alt)) {
      out.push(finding('1.1.1','minor',el,alt,
        'Alternative text begins with a redundant phrase such as “image of”.',
        'Remove the leading “image of” or “picture of”; screen readers already announce that the element is an image.'));
    } else if (alt.length > ALT_LONG) {
      out.push(finding('1.1.1','minor',el,alt,
        `Alternative text is longer than ${ALT_LONG} characters and may be tedious to hear.`,
        'Keep the alternative text brief and move detailed information, such as data in a chart, into the surrounding text, a caption, or a linked long description.'));
    }
  }
  return out;
}

// ---- 1.3.1 Info and relationships / 2.4.6 Headings and labels ---------------------------

const looksLikeFakeHeading = el => {
  const t = String(el.text ?? '').trim();
  if (!t || t.length > 100 || /[.,;:!?]$/.test(t) || t.split(/\s+/).length > 12) return false;
  return (Number.isFinite(el.font_size_pt) && el.font_size_pt >= 16) || (el.bold === true && el.standalone === true);
};

export function checkHeadings(doc) {
  const out = [];
  if (notExtracted(doc,'headings')) return out;
  const headings = doc.elements.filter(el=>el.type === 'heading');
  const uncertainPages = new Set(doc.metadata?.unknown_heading_pages ?? []);
  const uncertainOrder = doc.metadata?.heading_order_unknown === true;
  const textChars = doc.elements.filter(el=>el.type === 'text').reduce((n,el)=>n+String(el.text ?? '').length,0);

  if (!headings.length && !uncertainPages.size && !uncertainOrder && textChars >= 1500) {
    out.push(finding('1.3.1','moderate',null,'',
      'The document has substantial text but no headings, so its structure is not available to assistive technology.',
      'Mark section titles with heading styles (Heading 1, Heading 2, and so on) so screen reader users can navigate by section.'));
  }

  let prev = 0;
  let previousPage = 0;
  const uncertainty = [...uncertainPages].sort((a,b) => a - b);
  let nextUncertain = 0;
  for (const h of headings) {
    const text = String(h.text ?? '').trim();
    if (!text) {
      out.push(finding('2.4.6','serious',h,`Heading level ${h.level}`,
        'A heading is empty.',
        'Add descriptive text to the heading or remove the empty heading.'));
      continue;
    }
    const page = h.location?.page ?? 0;
    while (uncertainty[nextUncertain] < previousPage) nextUncertain++;
    const comparable = !uncertainOrder && !(uncertainty[nextUncertain] <= page);
    if (comparable && prev === 0 && h.level !== 1) {
      out.push(finding('1.3.1','minor',h,text,
        `The first heading is level ${h.level} rather than level 1.`,
        'Start the document’s heading structure with a level 1 heading for the main title.'));
    } else if (comparable && prev && h.level > prev + 1) {
      out.push(finding('1.3.1','moderate',h,text,
        `Heading levels skip from ${prev} to ${h.level}.`,
        doc.metadata?.format === 'pdf'
          ? `Edit this heading’s tag in a PDF accessibility editor. Set the correct level, such as H${prev + 1}, or tag an existing intermediate heading if one belongs in the outline.`
          : `Change this heading to level ${prev + 1}, or add the missing intermediate heading, so the outline has no gaps.`));
    }
    prev = h.level;
    previousPage = page;
  }

  for (const el of doc.elements) {
    if (el.type === 'text' && !uncertainOrder && !uncertainPages.has(el.location?.page) && looksLikeFakeHeading(el)) {
      out.push(finding('1.3.1','moderate',el,el.text,
        'Text appears to be a section title but uses visual formatting instead of a semantic heading.',
        'Apply the appropriate heading style to this title instead of only making it bold or large, keeping levels consistent with the surrounding structure.'));
    }
  }
  return out;
}

// ---- 1.4.3 Contrast (minimum), level AA -------------------------------------------------

const DEFAULT_BACKGROUND = {r:255,g:255,b:255};

export function checkContrast(doc) {
  const out = [];
  for (const el of doc.elements) {
    if (el.color === undefined || el.color === null) continue;
    const text = String(el.text ?? '').trim();
    if (!text) continue;
    const fg = parseColor(el.color);
    const bg = el.background === undefined || el.background === null ? DEFAULT_BACKGROUND : parseColor(el.background);
    if (!fg || !bg) continue; // Unknown color formats are skipped rather than guessed.
    const ratio = contrastRatio(fg,bg);
    const large = isLargeText(el);
    const required = large ? 3 : 4.5;
    if (ratio >= required) continue;
    const shown = ratio.toFixed(2);
    out.push(finding('1.4.3', ratio < required - 1.5 ? 'serious' : 'moderate', el, text,
      `${large ? 'Large' : 'Normal-sized'} text has a contrast ratio of ${shown}:1, below the required ${required}:1.`,
      `Darken the text or lighten the background (or the reverse) until the contrast ratio is at least ${required}:1. Verify the revised colors with a contrast checker.`));
  }
  return out;
}

// ---- 2.4.4 Link purpose (in context) ----------------------------------------------------

const GENERIC_LINK = /^(click here|here|click|read more|more|more info|more information|learn more|link|this link|this|go|details|see more|continue)$/i;

export function checkLinks(doc) {
  const out = [];
  for (const el of doc.elements) {
    if (el.type !== 'link') continue;
    const text = String(el.text ?? '').trim();
    if (!text) {
      out.push(finding('2.4.4','serious',el,el.href || 'Link',
        'A link has no text, so its purpose cannot be determined.',
        'Add visible link text that describes the destination.'));
    } else if (GENERIC_LINK.test(text.replace(/[.!…]+$/,''))) {
      out.push(finding('2.4.4','moderate',el,text,
        `Link text “${snippet(text)}” does not describe the link’s destination.`,
        'Replace the link text with words that describe where the link goes, such as the title of the linked page or file.'));
    } else if (/^(https?:\/\/|www\.)\S+$/i.test(text)) {
      out.push(finding('2.4.4','minor',el,text,
        'Link text is a raw URL, which is hard to understand when read aloud.',
        'Replace the URL with descriptive link text, such as the title of the linked resource.'));
    }
  }
  return out;
}

// ---- 1.3.1 Table headers ----------------------------------------------------------------

export function checkTables(doc) {
  const out = [];
  if (notExtracted(doc,'tables')) return out;
  const guidance = {
    html:'Use <th> for header cells. Add scope="row" or scope="col" so the headers identify the related data cells.',
    docx:'Select the header row in Word and enable Repeat Header Rows. Verify the header associations after exporting the document.',
    pdf:'In a PDF accessibility editor, set the header cells to TH and set their scope or associations with data cells. Verify the headers with a screen reader.',
  }[doc.metadata?.format] ?? 'Mark the table’s header cells so a screen reader can announce the headers for the related data cells.';
  for (const el of doc.elements) {
    if (el.type !== 'table' || el.layout === true) continue;
    const rows = Number.isInteger(el.rows) ? el.rows : Array.isArray(el.cells) ? el.cells.length : null;
    if (rows !== null && rows < 2) continue;
    if (el.has_header_row !== true && el.has_header_column !== true) {
      out.push(finding('1.3.1','moderate',el,el.caption || 'Table',
        'A data table has no header row or column defined.',
        guidance));
    }
  }
  return out;
}

// ---- 1.3.1 Untagged PDF -----------------------------------------------------------------

// An untagged PDF exposes no headings, lists, tables, reading order, or image descriptions
// to assistive technology. The parser marks it with metadata.tagged === false; the
// structure checks that depend on tags are skipped, so this single finding replaces them.
export function checkTagging(doc) {
  if (doc.metadata?.tagged !== false) return [];
  return [finding('1.3.1','serious',null,'',
    'The PDF is not tagged, so its headings, tables, reading order, and image descriptions are not available to assistive technology.',
    'Recreate the PDF from its source document with accessibility tags turned on (for example, in Word use Save As PDF with “Document structure tags for accessibility” selected), or add tags with a PDF remediation tool. Then give each informative image alternative text.')];
}

// ---- 2.4.2 Page titled / 3.1.1 Language of page -----------------------------------------

export function checkMetadata(doc) {
  const out = [];
  const meta = doc.metadata || {};
  if (!notExtracted(doc,'title') && (typeof meta.title !== 'string' || !meta.title.trim())) {
    out.push(finding('2.4.2','moderate',null,'',
      'The document has no title in its properties.',
      'Set a descriptive title in the document’s properties so it is announced when the document opens.'));
  }
  if (!notExtracted(doc,'language') && (typeof meta.language !== 'string' || !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(meta.language.trim()))) {
    out.push(finding('3.1.1','moderate',null,'',
      'The document’s primary language is not specified.',
      'Set the document language (for example, “en-US”) so screen readers use the correct pronunciation.'));
  }
  return out;
}

// ---- 4.1.2 Name, Role, Value -------------------------------------------------------------

export function checkFormLabels(doc) {
  return doc.elements
    .filter(el => el.type === 'form_control' && el.labelled !== true)
    .map(el => finding('4.1.2','moderate',el,el.text || el.control_type || 'Form control',
      el.pdf_field ? 'A PDF form field has no accessible name.' : 'A form control has no associated label or accessible name.',
      el.pdf_field ? 'Set a descriptive Tooltip in the PDF form editor, or a label for a pushbutton. Verify the announced name with a screen reader.'
        : 'Associate a visible label with the control or provide a programmatically determinable accessible name that clearly identifies its purpose.'));
}

export function pdfReviewNotes(doc) {
  const notes = [];
  for (const element of doc.elements) {
    const page = element.location?.page;
    if (element.type === 'pdf_scan' && element.ocr !== 'no_text') {
      const description = {
        text:'OCR found text in this page’s image. The uploaded page lacks a usable text layer.',
        unavailable:'This page may be a scan. Text recognition was unavailable.',
        budget:'This page may be a scan. Text recognition reached the processing budget.',
      }[element.ocr];
      if (description) notes.push({page, description,
        suggested_fix:'Run OCR on the original PDF if the page contains text. Check the recognized text, then add or verify the PDF tags and reading order.'});
    } else if (element.type === 'pdf_reading_order') {
      notes.push({page, description:'The PDF tag order may differ from the visual reading order.',
        suggested_fix:'Read the page with a screen reader. If it reads the columns or paragraphs in the wrong order, reorder the tags in a PDF editor and check again.'});
    }
  }
  for (const page of doc.metadata?.unknown_heading_pages ?? []) {
    notes.push({page, description:'Some heading tags on this page could not be matched to the page text.',
      suggested_fix:'Inspect the heading tags and verify that a screen reader announces the expected headings and levels.'});
  }
  return notes.sort((a,b) => a.page - b.page);
}
