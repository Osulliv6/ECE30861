"""Automatically repair the accessibility problems that have a safe, mechanical fix.

remediate(src, dst) writes a repaired copy of src to dst and returns the list of
changes, plus the parsed structure of both files so the caller (the Node engine)
can report which findings remain. It never invents content that needs human
judgment: missing alt text, vague link text, and untagged PDFs are left for a
person, and appear in the remaining findings.

Repairs, by format:

| Repair                              | WCAG  | HTML | DOCX | PDF |
| ----------------------------------- | ----- | ---- | ---- | --- |
| Set the document language           | 3.1.1 | yes  | yes  | yes |
| Set the document title              | 2.4.2 | yes  | yes  | yes |
| Remove empty headings               | 2.4.6 | yes  | yes  | no  |
| Close gaps in heading levels        | 1.3.1 | yes  | yes  | no  |
| Mark the first table row as header  | 1.3.1 | yes  | yes  | no  |
| Adjust low-contrast text colors     | 1.4.3 | yes  | yes  | no  |

Only problems that exist are changed; an existing valid title or language is kept.
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

from .css import StyleResolver, contrast_ratio, fix_contrast, parse_color, required_ratio, to_hex
from .document_parser import EXTENSIONS, ParseError, parse_document

LANGUAGE_RE = re.compile(r'^[a-z]{2,3}(-[a-z0-9]{2,8})*$', re.I)
DEFAULT_LANGUAGE = 'en'
TITLE_MAX = 80
WHITE = (255, 255, 255, 1.0)


def _clean(s: str | None) -> str:
    return re.sub(r'\s+', ' ', s or '').strip()


def _snippet(text: str) -> dict | None:
    text = _clean(text)
    return {'snippet': text if len(text) <= 80 else text[:79] + '…'} if text else None


def _change(criterion: str, description: str, text: str = '', needs_review: bool = True) -> dict:
    return {'wcag_criterion': criterion, 'description': description, 'location': _snippet(text),
            'needs_review': needs_review}


def valid_language(value: Any) -> bool:
    return isinstance(value, str) and bool(LANGUAGE_RE.match(value.strip()))


def derive_title(parsed: dict) -> str | None:
    """A title candidate from the document's own text: its first H1, else its first heading,
    else its first line of text."""
    elements = parsed.get('elements', [])
    candidates = ([e for e in elements if e.get('type') == 'heading' and e.get('level') == 1] +
                  [e for e in elements if e.get('type') == 'heading'] +
                  [e for e in elements if e.get('type') == 'text'])
    for element in candidates:
        text = _clean(element.get('text'))
        if text:
            if len(text) > TITLE_MAX:
                text = text[:TITLE_MAX].rsplit(' ', 1)[0].rstrip(',;:') + '…'
            return text
    return None


def relevel(levels: list[int]) -> list[int]:
    """Close gaps in a heading outline while keeping its shape: each heading becomes one
    level below its nearest preceding heading with a smaller original level (level 1 when
    there is none), so siblings stay siblings and only skipped levels are removed."""
    out, stack = [], []  # stack of (original level, new level) for the open sections
    for level in levels:
        while stack and stack[-1][0] >= level:
            stack.pop()
        new = stack[-1][1] + 1 if stack else 1
        stack.append((level, new))
        out.append(new)
    return out


class Plan:
    """Collects the repairs shared by every format."""

    def __init__(self, parsed: dict, language: str | None, title: str | None):
        meta = parsed.get('metadata') or {}
        not_extracted = set(meta.get('not_extracted') or [])
        self.changes: list[dict] = []
        self.language = None
        if 'language' not in not_extracted and not valid_language(meta.get('language')):
            self.language = (language or DEFAULT_LANGUAGE).strip()
            self.language_from_user = bool(language)
        self.title = None
        if 'title' not in not_extracted and not _clean(meta.get('title')):
            self.title = _clean(title) or derive_title(parsed)
            self.title_from_user = bool(_clean(title))

    def record_language(self):
        assumed = '' if self.language_from_user else ' (the service default; confirm it matches the document)'
        self.changes.append(_change('3.1.1', f'Set the document language to "{self.language}"{assumed}.',
                                    needs_review=not self.language_from_user))

    def record_title(self):
        source = '' if self.title_from_user else ' from the document’s first heading or line'
        self.changes.append(_change('2.4.2', f'Set the document title to "{self.title}"{source}.',
                                    needs_review=not self.title_from_user))


# ---- HTML ----------------------------------------------------------------------------------

HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']
TEXT_TAGS = HEADING_TAGS + ['p', 'li', 'blockquote', 'pre', 'figcaption', 'a']


def _set_inline_color(tag, color: str, important: bool):
    style = re.sub(r'(?:^|;)\s*color\s*:[^;]*', '', tag.get('style', ''), flags=re.I).strip().strip(';').strip()
    declaration = f'color: {color}{" !important" if important else ""}'
    tag['style'] = f'{style}; {declaration}' if style else declaration


def _remediate_html(src: Path, dst: Path, plan: Plan):
    from bs4 import BeautifulSoup
    raw = src.read_text(encoding='utf-8-sig')
    soup = BeautifulSoup(raw, 'html.parser')
    styles = StyleResolver(soup)
    changes = plan.changes

    # Contrast fixes are computed against the original styles, then applied.
    contrast = []
    for tag in soup.find_all(TEXT_TAGS):
        if tag.find_parent(['script', 'style', 'template', 'noscript']):
            continue
        text = _clean(tag.get_text(' ', strip=True))
        style = styles.text_style(tag)
        if not text or 'color' not in style:
            continue
        fg, bg = parse_color(style['color']), parse_color(style.get('background') or '#ffffff')
        required = required_ratio(style.get('font_size_pt'), style.get('bold'))
        if fg and bg and contrast_ratio(fg, bg) < required:
            fixed = fix_contrast(fg, bg, required)
            if fixed:
                own = styles.declared(tag, 'color')
                contrast.append((tag, to_hex(fixed), bool(own and own[1]), style['color'], text,
                                 contrast_ratio(fixed, bg), required))
    for tag, color, important, old, text, ratio, required in contrast:
        _set_inline_color(tag, color, important)
        changes.append(_change('1.4.3', f'Changed the text color from {old} to {color} '
                                        f'(contrast {ratio:.2f}:1, required {required:g}:1).', text))

    if plan.language and soup.html is not None:
        soup.html['lang'] = plan.language
        plan.record_language()
    if plan.title and soup.html is not None:
        head = soup.head
        if head is None:
            head = soup.new_tag('head')
            soup.html.insert(0, head)
        title_tag = soup.title or soup.new_tag('title')
        title_tag.string = plan.title
        if title_tag.parent is None:
            head.append(title_tag)
        plan.record_title()

    for heading in soup.find_all(HEADING_TAGS):
        if not heading.get_text(strip=True) and not heading.find(['img', 'svg', 'object', 'input']):
            changes.append(_change('2.4.6', f'Removed an empty level {heading.name[1]} heading.',
                                   needs_review=False))
            heading.decompose()

    headings = soup.find_all(HEADING_TAGS)
    for heading, new in zip(headings, relevel([int(h.name[1]) for h in headings])):
        old = int(heading.name[1])
        if new != old:
            heading.name = f'h{new}'
            changes.append(_change('1.3.1', f'Changed a heading from level {old} to level {new} so the '
                                            'outline has no gaps. Check its visual size still fits.',
                                   heading.get_text(' ', strip=True)))

    for table in soup.find_all('table'):
        if (table.get('role') or '').lower() in ('presentation', 'none'):
            continue
        rows = table.find_all('tr')
        if len(rows) < 2 or rows[0].find('th') or all(r.find('th', recursive=False) for r in rows):
            continue
        cells = rows[0].find_all('td', recursive=False)
        for cell in cells:
            cell.name = 'th'
            cell['scope'] = 'col'
        if cells:
            caption = table.caption.get_text(' ', strip=True) if table.caption else ' '.join(
                c.get_text(' ', strip=True) for c in cells)
            changes.append(_change('1.3.1', 'Marked the first table row as the header row. Confirm '
                                            'that row contains column headings.', caption))

    dst.write_text(str(soup), encoding='utf-8')


# ---- DOCX ----------------------------------------------------------------------------------

def _remediate_docx(src: Path, dst: Path, plan: Plan):
    from docx import Document
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import RGBColor
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(src)
    changes = plan.changes

    if plan.language:
        rpr = doc.styles['Normal'].element.get_or_add_rPr()
        lang = rpr.find(qn('w:lang'))
        if lang is None:
            lang = OxmlElement('w:lang')
            rpr.append(lang)
        lang.set(qn('w:val'), plan.language)
        doc.core_properties.language = plan.language
        plan.record_language()
    if plan.title:
        doc.core_properties.title = plan.title
        plan.record_title()

    body = [Paragraph(c, doc) if c.tag == qn('w:p') else Table(c, doc)
            for c in doc.element.body.iterchildren() if c.tag in (qn('w:p'), qn('w:tbl'))]
    paragraphs = [b for b in body if isinstance(b, Paragraph)]

    def heading_level(p):
        m = re.match(r'^Heading\s*([1-6])$', p.style.name if p.style is not None else '', re.I)
        return int(m.group(1)) if m else None

    for p in paragraphs:
        level = heading_level(p)
        if level and not _clean(p.text) and not p._p.findall('.//' + qn('w:drawing')):
            p.style = doc.styles['Normal']
            changes.append(_change('2.4.6', f'Changed an empty Heading {level} paragraph to Normal text.',
                                   needs_review=False))

    headings = [p for p in paragraphs if heading_level(p)]
    for p, new in zip(headings, relevel([heading_level(p) for p in headings])):
        old = heading_level(p)
        if new == old:
            continue
        try:
            p.style = doc.styles[f'Heading {new}']
        except KeyError:
            continue  # The style is not defined in this document; left for manual repair.
        changes.append(_change('1.3.1', f'Changed a heading from Heading {old} to Heading {new} so the '
                                        'outline has no gaps.', p.text))

    for table in (b for b in body if isinstance(b, Table)):
        rows = table.rows
        if len(rows) < 2:
            continue
        if any(r._tr.trPr is not None and r._tr.trPr.find(qn('w:tblHeader')) is not None for r in rows):
            continue
        rows[0]._tr.get_or_add_trPr().append(OxmlElement('w:tblHeader'))
        changes.append(_change('1.3.1', 'Marked the first table row as a repeating header row. Confirm '
                                        'that row contains column headings.',
                               ' '.join(c.text for c in rows[0].cells)))

    # The parser and engine assume a white page; paragraph shading is not evaluated.
    for p in paragraphs:
        for run in p.runs:
            if not (run.text or '').strip():
                continue
            try:
                rgb = run.font.color.rgb if run.font.color is not None else None
            except (AttributeError, ValueError):
                rgb = None
            if rgb is None:
                continue
            fg = parse_color('#' + str(rgb))
            size = run.font.size.pt if run.font.size is not None else None
            required = required_ratio(size, bool(run.bold))
            if not fg or contrast_ratio(fg, WHITE) >= required:
                continue
            fixed = fix_contrast(fg, WHITE, required)
            if not fixed:
                continue
            run.font.color.rgb = RGBColor.from_string(to_hex(fixed)[1:].upper())
            changes.append(_change('1.4.3', f'Changed the text color from #{str(rgb).lower()} to {to_hex(fixed)} '
                                            f'(contrast {contrast_ratio(fixed, WHITE):.2f}:1, required {required:g}:1).',
                                   run.text))
    doc.save(dst)


# ---- PDF -----------------------------------------------------------------------------------

PDF_INFO_KEYS = ('author', 'producer', 'creator', 'title', 'subject', 'keywords', 'creationDate', 'modDate', 'trapped')


def _remediate_pdf(src: Path, dst: Path, plan: Plan):
    import pymupdf as fitz
    doc = fitz.open(src)
    if doc.needs_pass:
        raise ParseError('UNPROCESSABLE_FILE', 'Password-protected PDFs are not supported.')
    catalog = doc.pdf_catalog()
    if plan.language:
        doc.xref_set_key(catalog, 'Lang', fitz.get_pdf_str(plan.language))
        plan.record_language()
    if plan.title:
        info = {k: v for k, v in (doc.metadata or {}).items() if k in PDF_INFO_KEYS and v}
        info['title'] = plan.title
        doc.set_metadata(info)
        # PDF technique PDF18: viewers show the title instead of the file name.
        doc.xref_set_key(catalog, 'ViewerPreferences/DisplayDocTitle', 'true')
        plan.record_title()
    doc.save(dst, garbage=1)
    doc.close()


# ---- Entry point ---------------------------------------------------------------------------

def remediate(src: str | Path, dst: str | Path, *, language: str | None = None,
              title: str | None = None) -> dict[str, Any]:
    """Write a repaired copy of src to dst. Returns {changes, before, after}, where before and
    after are parser output for the engine. Raises ParseError like parse_document."""
    src, dst = Path(src), Path(dst)
    if language is not None and not valid_language(language):
        raise ParseError('INVALID_LANGUAGE', 'language must be a BCP 47 tag such as "en" or "en-US".')
    before = parse_document(src)
    extension = src.suffix.lower()
    if extension not in EXTENSIONS or dst.suffix.lower() != extension:
        raise ParseError('UNSUPPORTED_FILE_TYPE', 'Unsupported document type.')
    plan = Plan(before, language, title)
    try:
        if extension in ('.html', '.htm'):
            _remediate_html(src, dst, plan)
        elif extension == '.docx':
            _remediate_docx(src, dst, plan)
        elif extension == '.pdf':
            _remediate_pdf(src, dst, plan)
        else:
            shutil.copyfile(src, dst)  # Plain text has nothing that can be repaired.
    except ParseError:
        raise
    except Exception as exc:
        raise ParseError('UNPROCESSABLE_FILE', f'Document could not be repaired: {type(exc).__name__}') from exc
    after = parse_document(dst)
    return {'changes': plan.changes, 'before': before, 'after': after}
