"""Parse supported documents into the team's engine input contract.

Only extracts observable structure. It does not assert WCAG violations.
"""
from __future__ import annotations
import html
import io
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from .css import StyleResolver
from .pdf_tags import read_structure
from .table_logic import own_rows, table_semantics

SUPPORTED_MIME_TYPES = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/pdf', 'text/html', 'text/plain'
]
EXTENSIONS = {'.docx': SUPPORTED_MIME_TYPES[0], '.pdf': SUPPORTED_MIME_TYPES[1],
              '.html': 'text/html', '.htm': 'text/html', '.txt': 'text/plain'}
MAX_HTML_ELEMENTS = 150_000

class ParseError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _limited_html_builder():
    """Build BeautifulSoup's tree while stopping as soon as the HTML cap is crossed."""
    from bs4.builder import HTMLParserTreeBuilder
    from bs4.builder._htmlparser import BeautifulSoupHTMLParser

    class LimitedHTMLParser(BeautifulSoupHTMLParser):
        def __init__(self, soup, *args, **kwargs):
            self.start_tag_count = 0
            super().__init__(soup, *args, **kwargs)

        def handle_starttag(self, tag, attrs, handle_empty_element=True):
            self.start_tag_count += 1
            if self.start_tag_count > MAX_HTML_ELEMENTS:
                raise ParseError('UNPROCESSABLE_FILE', 'HTML document exceeds the supported element limit.')
            super().handle_starttag(tag, attrs, handle_empty_element)

    class LimitedHTMLTreeBuilder(HTMLParserTreeBuilder):
        def feed(self, markup):
            super().feed(markup, _parser_class=LimitedHTMLParser)

    return LimitedHTMLTreeBuilder()

def _clean(s):
    return re.sub(r'\s+', ' ', s or '').strip()

def _check_html_complexity(raw: str):
    """Reject pathological DOMs before allocating a full BeautifulSoup tree.

    This deliberately counts syntactic opening tags only. It is a fast guard for
    resource limits, while BeautifulSoup remains the authoritative parser for an
    accepted document. Using ``HTMLParser`` here made an exactly-at-limit page
    take a second complete Python-level parse before its real parse.
    """
    # Skip comments, raw text and quoted attributes so literal markup does not
    # count as DOM elements. The builder still enforces the authoritative cap.
    tokens = re.compile(
        r'<!--.*?(?:-->|\Z)|'
        r'<(script|style)(?=[\s/>])(?:[^>"\']|"[^"]*"|\'[^\']*\')*>.*?(?:</\1\s*>|\Z)|'
        r'<[A-Za-z][A-Za-z0-9:_-]*(?=[\s/>])(?:[^>"\']|"[^"]*"|\'[^\']*\')*>',
        re.I | re.S,
    )
    count = 0
    for token in tokens.finditer(raw):
        if not token.group().startswith('<!--'):
            count += 1
            if count > MAX_HTML_ELEMENTS:
                raise ParseError('UNPROCESSABLE_FILE', 'HTML document exceeds the supported element limit.')

def _add(elements, item):
    elements.append(item)

def _rgb_from_int(value):
    if value is None: return None
    return f'#{int(value) & 0xffffff:06x}'

def _style_from_runs(runs):
    runs = [r for r in runs if (getattr(r,'text',None) or '').strip()]
    if not runs: return {}
    first = runs[0]
    out = {}
    if first.bold is not None: out['bold'] = bool(first.bold)
    if first.font.size is not None: out['font_size_pt'] = round(first.font.size.pt, 2)
    try:
        if first.font.color and first.font.color.rgb:
            out['color'] = '#' + str(first.font.color.rgb).lower()
    except (AttributeError, ValueError): pass
    return out

def _docx_links(paragraph):
    from docx.oxml.ns import qn
    rels = paragraph.part.rels
    for node in paragraph._p.iterchildren():
        if node.tag == qn('w:hyperlink'):
            rid = node.get(qn('r:id'))
            href = str(rels[rid].target_ref) if rid and rid in rels else None
            text = _clean(''.join(t.text or '' for t in node.iter(qn('w:t'))))
            yield text, href

def _docx_images(paragraph):
    from docx.oxml.ns import qn
    for drawing in paragraph._p.iter(qn('w:drawing')):
        for dp in drawing.iter(qn('wp:docPr')):
            alt = dp.get('descr')
            if alt is None: alt = dp.get('title')
            yield {'type':'image','alt': alt, 'decorative': alt == '',
                   'src': dp.get('name') or None}
    # VML images also occur in legacy DOCX files; do not silently skip them.
    for im in paragraph._p.iter('{urn:schemas-microsoft-com:vml}imagedata'):
        yield {'type':'image','alt': im.get('alt'), 'decorative':False,
               'src': im.get('title') or None}

def _docx_paragraph(paragraph, elements, location, standalone=True):
    text = _clean(paragraph.text)
    style = paragraph.style.name if paragraph.style is not None else ''
    match = re.match(r'^Heading\s*([1-6])$', style, re.I)
    if match:
        item = {'type':'heading','level':int(match.group(1)),'text':text,'location':location}
        item.update(_style_from_runs(paragraph.runs)); _add(elements,item)
    elif text:
        item = {'type':'text','text':text,'standalone':standalone,'location':location}
        item.update(_style_from_runs(paragraph.runs)); _add(elements,item)
    for link_text, href in _docx_links(paragraph):
        _add(elements, {'type':'link','text':link_text,'href':href,'location':location})
    for img in _docx_images(paragraph):
        img['location'] = location
        _add(elements,img)

def _docx_table(table, elements, location):
    from docx.oxml.ns import qn
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    if not table.rows:
        return
    header = any(row._tr.trPr is not None and row._tr.trPr.find(qn('w:tblHeader')) is not None
                 for row in table.rows)
    _add(elements, {'type':'table', 'rows':len(table.rows),
                    'has_header_row':bool(header), 'has_header_column':False,
                    'layout':False, 'location':location,
                    'cells':[[cell.text for cell in row.cells] for row in table.rows]})
    seen_cells = set()
    for row in table.rows:
        for cell in row.cells:
            if cell._tc in seen_cells:
                continue
            seen_cells.add(cell._tc)
            # Cell text is not a standalone section title merely because it is bold.
            for child in cell._tc.iterchildren():
                if child.tag == qn('w:p'):
                    _docx_paragraph(Paragraph(child, cell), elements, location, standalone=False)
                elif child.tag == qn('w:tbl'):
                    _docx_table(Table(child, cell), elements, location)

def _docx(path):
    from docx import Document
    from docx.oxml.ns import qn
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    doc = Document(path)
    props = doc.core_properties
    metadata = {'title': _clean(props.title), 'language':None,
                'author':_clean(props.author), 'format':'docx'}
    # Resolve the document's default language without guessing from its prose.
    # A language on Normal overrides the document-wide default; Word stores
    # that default in styles.xml/docDefaults when it is not repeated on Normal.
    style = doc.styles['Normal']
    lang = style.element.rPr.find(qn('w:lang')) if style.element.rPr is not None else None
    if lang is not None: metadata['language'] = lang.get(qn('w:val'))
    if not metadata['language']:
        defaults = doc.styles.element.find(qn('w:docDefaults'))
        run_default = defaults.find(qn('w:rPrDefault')) if defaults is not None else None
        run_props = run_default.find(qn('w:rPr')) if run_default is not None else None
        lang = run_props.find(qn('w:lang')) if run_props is not None else None
        if lang is not None: metadata['language'] = lang.get(qn('w:val'))
    elements = []
    for index, child in enumerate(doc.element.body.iterchildren(),1):
        location={'line':index}
        if child.tag == qn('w:p'):
            _docx_paragraph(Paragraph(child,doc), elements, location)
        elif child.tag == qn('w:tbl'):
            _docx_table(Table(child, doc), elements, location)
    # Extract content from DOCX headers/footers. Word stores these in separate
    # document parts, so walking doc.element.body never reaches them.
    # Use a monotonically increasing position for engine-compatible locations;
    # part and section details are additional provenance fields.
    seen_parts = set()
    position = len(list(doc.element.body.iterchildren()))
    for section_number, section in enumerate(doc.sections, 1):
        for kind in ('header', 'first_page_header', 'even_page_header',
                     'footer', 'first_page_footer', 'even_page_footer'):
            if kind.startswith('first_page_') and not section.different_first_page_header_footer:
                continue
            if kind.startswith('even_page_') and not doc.settings.odd_and_even_pages_header_footer:
                continue
            story = getattr(section, kind)
            # A later section can enable a variant inherited from an earlier section
            # where it was disabled. Deduplicate by part only after the variant is active.
            part_name = str(story.part.partname)
            if part_name in seen_parts:
                continue
            seen_parts.add(part_name)
            for child in story._element.iterchildren():
                position += 1
                location = {'line':position, 'section':section_number, 'part':kind}
                if child.tag == qn('w:p'):
                    _docx_paragraph(Paragraph(child, story), elements, location)
                elif child.tag == qn('w:tbl'):
                    _docx_table(Table(child, story), elements, location)
    return {'metadata':metadata,'elements':elements,
            'parser_info':{'format':'docx','reading_order':'document body order (approximate for floating objects)',
                           'limitations':['DOCX has no stable page numbers without rendering',
                                          'Only explicitly marked Word heading styles and header rows are authoritative',
                                          'Header/footer extraction is by section, not visual page order']}}

def _html(path):
    from bs4 import BeautifulSoup, Comment, NavigableString, Tag
    raw=Path(path).read_text(encoding='utf-8-sig')
    # Do a lightweight count before allocating BeautifulSoup nodes. On a document
    # far above the cap this exits at element 150,001 instead of constructing
    # 150,000 DOM nodes first. The limited builder remains a second guard against
    # future changes that bypass this preflight.
    _check_html_complexity(raw)
    soup=BeautifulSoup(raw, builder=_limited_html_builder())
    title = _clean(soup.title.get_text(' ',strip=True)) if soup.title else ''
    metadata={'title':title,'language':soup.html.get('lang') if soup.html else None,'format':'html'}
    # Resolve embedded and inline CSS before <style> elements are removed.
    styles=StyleResolver(soup)
    if styles.external_stylesheets: metadata['external_stylesheets']=styles.external_stylesheets
    ids, labels, candidates, unwanted = {}, {}, [], []
    for node in soup.descendants:
        if not isinstance(node, Tag):
            continue
        if node.name in ('script','style','noscript','template'):
            unwanted.append(node)
        elif node.has_attr('id') or (node.name == 'label' and node.has_attr('for')):
            candidates.append(node)
    for node in unwanted:
        if node.name is not None:
            node.decompose()
    for node in candidates:
        if node.name is None:
            continue
        if node.has_attr('id'):
            ids.setdefault(str(node['id']), node)
        if node.name == 'label' and node.has_attr('for'):
            labels.setdefault(str(node['for']), []).append(node)
    root = soup.body or soup
    elements = []

    def loc(tag):
        out = {'line':tag.sourceline} if tag.sourceline else {}
        if tag.get('id'):
            out['selector'] = '#' + str(tag['id'])
        return out

    headings = {f'h{i}' for i in range(1, 7)}
    separate = {'a', 'img', 'table', 'p', 'li', 'blockquote', 'pre', 'figcaption', *headings}

    def aria_hidden(node):
        value = node.get('aria-hidden')
        return bool(value and value.strip().lower() == 'true')

    def hidden_from_at(node):
        return styles.hidden(node) or aria_hidden(node) or any(aria_hidden(parent) for parent in node.parents)

    def is_image(node):
        return node.name == 'img' or (node.name == 'svg' and 'img' in str(node.get('role') or '').lower().split())

    def aria_name(node, allow_references=True):
        if allow_references:
            referenced = []
            for ident in dict.fromkeys(str(node.get('aria-labelledby') or '').split()):
                target = ids.get(ident)
                if target is not None:
                    # A directly referenced hidden label can contribute its contents.
                    hidden_reference = hidden_from_at(target)
                    ref_name = aria_name(target, allow_references=False)
                    referenced.append(ref_name or content_name(target, hidden_reference, allow_references=False))
            if any(referenced):
                return _clean(' '.join(referenced))
        return _clean(node.get('aria-label'))

    def image_name(node, allow_references=True):
        name = aria_name(node, allow_references)
        if name:
            return name
        if node.name == 'img':
            return node.get('alt') if node.has_attr('alt') else None
        title = node.find('title', recursive=False)
        return (_clean(title.get_text(' ', strip=True)) or None) if title else None

    def content_name(node, allow_hidden=False, allow_references=True):
        if is_image(node):
            return _clean(image_name(node, allow_references))
        parts = []
        for child in node.children:
            if isinstance(child, Comment):
                continue
            if isinstance(child, NavigableString):
                parts.append(str(child))
            elif isinstance(child, Tag) and (allow_hidden or not (aria_hidden(child) or styles.hidden(child))):
                parts.append(content_name(child, allow_hidden, allow_references))
        return _clean(' '.join(parts))

    def form_control_label(node, input_type):
        name = aria_name(node)
        if name:
            return name
        attached = labels.get(str(node.get('id')), [])
        wrapping = node.find_parent('label')
        if wrapping is not None and not wrapping.has_attr('for'):
            attached = [*attached, wrapping]
        name = _clean(' '.join(content_name(label) for label in attached if not hidden_from_at(label)))
        if name:
            return name
        if node.name == 'button':
            name = content_name(node)
        elif input_type == 'image':
            name = _clean(node.get('alt'))
        elif input_type in ('submit', 'reset'):
            name = _clean(node.get('value')) or input_type
        elif input_type == 'button':
            name = _clean(node.get('value'))
        return name or _clean(node.get('title'))

    def text_runs(tag):
        # Resolve formatting at the text node's own parent, not at its paragraph.
        runs = []
        def collect(parent):
            for child in parent.children:
                if isinstance(child, Comment):
                    continue
                if isinstance(child, NavigableString):
                    style = styles.text_style(parent)
                    if runs and runs[-1][1] == style:
                        runs[-1][0] += str(child)
                    else:
                        runs.append([str(child), style])
                elif isinstance(child, Tag) and child.name not in separate and not is_image(child):
                    if child.name == 'br' and runs:
                        runs[-1][0] += ' '
                    else:
                        collect(child)
        collect(tag)
        return [(_clean(text), style) for text, style in runs if _clean(text)]
    def add_semantic_text(item, node):
        runs = text_runs(node)
        if len(runs) == 1 and runs[0][0] == item['text']:
            item.update(runs[0][1])
            _add(elements, item)
        else:
            # Keep one heading/link for structure checks. Its text runs carry
            # contrast styles separately so mixed colors are not flattened.
            _add(elements, item)
            for text, style in runs:
                _add(elements, {'type':'text', 'text':text, 'standalone':False,
                                'location':item['location'], **style})
    def walk(tag, ancestor_hidden=False):
        for node in tag.children:
            if not isinstance(node, Tag):
                continue
            name = node.name
            hidden = ancestor_hidden or aria_hidden(node)
            if not hidden and name in headings:
                item={'type':'heading','level':int(name[1]),'text':_clean(node.get_text(' ',strip=True)),'location':loc(node)}
                add_semantic_text(item, node)
                # Links/images inside headings still need independent checks.
                walk(node)
            elif is_image(node):
                if hidden or styles.hidden(node):
                    continue
                alt = image_name(node)
                _add(elements, {'type':'image', 'alt':alt, 'decorative':name == 'img' and alt == '',
                                'src':node.get('src'), 'location':loc(node)})
            elif name in ('input','select','textarea','button'):
                input_type = str(node.get('type') or 'text').lower() if name == 'input' else name
                if not hidden and input_type != 'hidden' and not styles.hidden(node):
                    label = form_control_label(node, input_type)
                    _add(elements, {'type':'form_control', 'control_type':input_type,
                                    'labelled':bool(label), 'text':label or input_type,
                                    'location':loc(node)})
            elif not hidden and name=='a' and node.has_attr('href') and not styles.hidden(node):
                link_name = aria_name(node) or content_name(node) or _clean(node.get('title'))
                item={'type':'link','text':link_name,
                      'href':node.get('href'),'location':loc(node)}
                add_semantic_text(item, node)
                walk(node)
            elif not hidden and name=='table':
                rows = own_rows(node)  # excludes rows of nested tables
                row_count, header_row, header_col = table_semantics(node, rows)
                _add(elements, {'type': 'table', 'rows': row_count,
                                'has_header_row': header_row,
                                'has_header_column': header_col,
                                'layout': str(node.get('role') or '').lower() in ('presentation', 'none'),
                               'caption':_clean(node.caption.get_text(' ',strip=True)) if node.caption else '',
                               'location':loc(node)})
                for r in rows:
                    for c in r.find_all(['td','th'], recursive=False):
                        walk(c, aria_hidden(r) or aria_hidden(c) or any(aria_hidden(parent) for parent in r.parents if parent is not node))
            elif name in ('p','li','blockquote','pre','figcaption','a') or name in headings:
                runs = text_runs(node)
                if runs:
                    location = loc(node)
                    for text, style in runs:
                        _add(elements, {'type':'text', 'text':text,
                                        'standalone':len(runs)==1,
                                        'location':location, **style})
                walk(node, hidden)
            else:
                walk(node, hidden)
    walk(root, aria_hidden(root) or any(aria_hidden(parent) for parent in root.parents))
    return {'metadata':metadata,'elements':elements,
            'parser_info':{'format':'html','reading_order':'DOM order',
                           'limitations':['External stylesheets (<link>) are not fetched; embedded <style> and inline styles are evaluated',
                                          'Conditional @media/@supports rules, CSS variables, background images, and gradients are not evaluated; affected contrast is skipped',
                                          'JavaScript-generated document content is not executed']}}

HEADING_ROLES={f'H{i}':i for i in range(1,7)}

def _pdf_span_style(span):
    return {'font_size_pt':round(span.get('size',0),2),
            'bold':'bold' in span.get('font','').lower() or bool(span.get('flags',0) & 16),
            'color':_rgb_from_int(span.get('color'))}

def _pdf_text_lines(block, page_index, elements):
    lines=[l for l in block.get('lines',[]) if _clean(' '.join(s.get('text','') for s in l.get('spans',[])))]
    for line in lines:
        spans=line.get('spans',[])
        item={'type':'text','text':_clean(' '.join(s.get('text','') for s in spans)),
              # A line is "standalone" (could be a visual heading) only when it is its own block.
              'standalone':len(lines)==1,'location':{'page':page_index}}
        item.update(_pdf_span_style(spans[0])); _add(elements,item)

def _pdf_struct_text(blocks):
    parts=[]
    for b in blocks:
        if 'std' in b or 'raw' in b: parts.append(_pdf_struct_text(b.get('blocks',[])))
        elif b.get('type')==0:
            parts.extend(s.get('text','') for l in b.get('lines',[]) for s in l.get('spans',[]))
    return ' '.join(parts)

def _pdf_first_span(blocks):
    for b in blocks:
        if 'std' in b or 'raw' in b:
            span=_pdf_first_span(b.get('blocks',[]))
            if span: return span
        elif b.get('type')==0:
            for l in b.get('lines',[]):
                for s in l.get('spans',[]):
                    if s.get('text','').strip(): return s
    return None

def _pdf_tagged_page(blocks, page_index, elements):
    """Headings and text from MuPDF's structured text, which follows the tag tree."""
    for b in blocks:
        if 'std' in b or 'raw' in b:
            role=b.get('std') or b.get('raw')
            children=b.get('blocks',[])
            if role in HEADING_ROLES:
                item={'type':'heading','level':HEADING_ROLES[role],'text':_clean(_pdf_struct_text(children)),
                      'location':{'page':page_index}}
                span=_pdf_first_span(children)
                if span: item.update(_pdf_span_style(span))
                _add(elements,item)
            elif role in ('Figure','Artifact'):
                continue  # Figures come from the tag tree with their alt text; text inside a chart is part of it.
            else:
                _pdf_tagged_page(children, page_index, elements)
        elif b.get('type')==0:
            _pdf_text_lines(b, page_index, elements)

def _pdf_tagged_fallback(blocks, by_mcid, roles, page_index, elements):
    # Tag order is independent of the order in which the page paints its text.
    for mcid in roles:
        block = by_mcid.get(mcid)
        if block is None:
            continue
        role = roles[mcid]
        if role in HEADING_ROLES:
            from .pdf_review import block_text
            item = {'type':'heading', 'level':HEADING_ROLES[role], 'text':block_text(block),
                    'location':{'page':page_index}}
            span = _pdf_first_span([block])
            if span:
                item.update(_pdf_span_style(span))
            _add(elements, item)
        elif role not in ('Figure', 'Artifact'):
            _pdf_text_lines(block, page_index, elements)
    mapped = {id(block) for block in by_mcid.values()}
    for block in blocks:
        if id(block) not in mapped:
            _pdf_text_lines(block, page_index, elements)


def _pdf(path):
    import pymupdf as fitz

    with fitz.open(path) as doc:
        if doc.needs_pass:
            raise ParseError('UNPROCESSABLE_FILE','Password-protected PDFs are not supported.')
        return _read_pdf(doc)


def _read_pdf(doc):
    import pymupdf as fitz
    from .pdf_review import ScanOCR, match_marked_text, reading_order_differs, scan_candidate, widget_label

    ocr = ScanOCR()
    structure=read_structure(doc)
    tagged=bool(structure and structure['elements'])
    metadata={'title':_clean(doc.metadata.get('title')),'language':None,'format':'pdf','tagged':tagged}
    try:
        lang=doc.pdf_catalog() and doc.xref_get_key(doc.pdf_catalog(),'Lang')
        if lang and lang[0]=='string': metadata['language']=lang[1].strip('()')
    except Exception: pass
    elements = []
    unknown_heading_pages = []
    roles_by_page = {}
    if tagged:
        for (page_number, mcid), role in structure['marked_content'].items():
            roles_by_page.setdefault(page_number, {})[mcid] = role
    for page_index, page in enumerate(doc, 1):
        location = {'page':page_index}
        text_blocks = page.get_text('dict', flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES,
                                    sort=not tagged)['blocks']
        if scan_candidate(page, text_blocks):
            _add(elements, {'type':'pdf_scan', 'ocr':ocr.check(page), 'location':location})
        for widget in page.widgets():
            flag_type, flags = doc.xref_get_key(widget.xref, 'F')
            hidden_flags = fitz.PDF_ANNOT_IS_INVISIBLE | fitz.PDF_ANNOT_IS_HIDDEN | fitz.PDF_ANNOT_IS_NO_VIEW
            if (flag_type == 'int' and int(flags) & hidden_flags) or not widget.rect.intersects(page.rect):
                continue
            label = widget_label(doc, widget)
            _add(elements, {'type':'form_control', 'pdf_field':True, 'labelled':bool(label),
                            'text':label or widget.field_name or 'PDF form field', 'location':location})
        if tagged:
            roles = roles_by_page.get(page_index, {}) if structure['has_parent_tree'] else {}
            ids = match_marked_text(doc, page, text_blocks) if roles else []
            by_mcid = {mcid:block for mcid, block in zip(ids, text_blocks)
                       if mcid is not None and roles.get(mcid)}
            block_indexes = {mcid:i for i, mcid in enumerate(ids) if mcid in by_mcid}
            if all(role in {'P', 'H', *HEADING_ROLES} for role in roles.values()):
                order = [block_indexes[mcid] for mcid in roles if mcid in block_indexes]
                if len(order) == len(roles) and reading_order_differs(text_blocks, order):
                    _add(elements, {'type':'pdf_reading_order', 'location':location})
            blocks = page.get_text('dict', flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES
                                   | fitz.TEXT_COLLECT_STRUCTURE)['blocks']
            before = len(elements)
            if any('std' in block or 'raw' in block for block in blocks):
                _pdf_tagged_page(blocks, page_index, elements)
            else:
                _pdf_tagged_fallback(text_blocks, by_mcid, roles, page_index, elements)
            expected = structure['heading_counts'].get(page_index, 0)
            observed = sum(element['type'] == 'heading' for element in elements[before:])
            if observed < expected:
                unknown_heading_pages.append(page_index)
            for number,figure in enumerate(structure['figures'],1):
                if figure['page']==page_index:
                    _add(elements,{'type':'image','alt':figure['alt'],'decorative':False,'src':f'Figure {number}',
                                   'location':{'page':page_index}})
            for table in structure['tables']:
                rows=table['rows']
                if table['page']==page_index:
                    _add(elements,{'type':'table','rows':len(rows),
                                   'has_header_row':bool(rows) and 'TH' in rows[0],
                                   'has_header_column':bool(rows) and all(r and r[0]=='TH' for r in rows),
                                   'layout':False,'location':{'page':page_index}})
        else:
            for number, image in enumerate(page.get_image_info(), 1):
                _add(elements, {'type':'image', 'alt':None, 'decorative':False,
                                'src':f'page-{page_index}-image-{number}', 'location':location})
            for block in text_blocks:
                _pdf_text_lines(block, page_index, elements)
        # PDF link target rectangles may not cleanly correspond to extracted words.
        for link in page.get_links():
            if not link.get('uri'): continue
            rect=link.get('from')
            label=_clean(page.get_textbox(rect)) if rect is not None else ''
            _add(elements,{'type':'link','text':label,'href':link['uri'],'location':{'page':page_index}})
    if tagged:
        for item in structure['figures']+structure['tables']:
            if item['page'] is None:  # no page reference anywhere in the element's subtree
                rows=item.get('rows')
                _add(elements,{'type':'image','alt':item['alt'],'decorative':False,'src':None} if rows is None else
                     {'type':'table','rows':len(rows),'has_header_row':bool(rows) and 'TH' in rows[0],
                      'has_header_column':bool(rows) and all(r and r[0]=='TH' for r in rows),'layout':False})
        # Without a ParentTree MuPDF cannot map page content to tags, so heading text is unknown.
        if unknown_heading_pages:
            metadata['unknown_heading_pages'] = unknown_heading_pages
        if (structure['truncated'] or None in structure['heading_counts'] or unknown_heading_pages) and not any(
            element['type'] == 'heading' for element in elements
        ):
            metadata['not_extracted'] = ['headings']
        if structure['truncated'] or None in structure['heading_counts']:
            metadata['heading_order_unknown'] = True
    else:
        # Untagged: headings, tables and alt text do not exist for assistive technology.
        # The engine reports the missing tags once instead of guessing structure from fonts.
        metadata['not_extracted']=['alt_text','headings','tables']
    limitations=['PDF background colors are not evaluated; scan OCR is limited to three candidate pages in English',
                 'PDF links are appended per page after extracted page content']
    if tagged:
        limitations+=['Structure checks cover headings, figures, tables, and interactive field names',
                      'Reading-order review is limited to unambiguous text in simple layouts']
    else:
        limitations+=['The PDF is untagged, so heading, table, and image semantics are absent']
    return {'metadata':metadata,'elements':elements,
            'parser_info':{'format':'pdf','tagged':tagged,
                           'reading_order':'tag tree order' if tagged else 'page order and spatial text sorting (approximate)',
                           'limitations':limitations}}

def _txt(path):
    raw=Path(path).read_text(encoding='utf-8-sig')
    elements=[{'type':'text','text':line.strip(),'standalone':True,'location':{'line':i}}
              for i,line in enumerate(raw.splitlines(),1) if line.strip()]
    # Plain text cannot carry a title, language, headings, images or tables, so none can be missing.
    return {'metadata':{'title':'','language':None,'format':'txt',
                        'not_extracted':['title','language','headings','alt_text','tables']},'elements':elements,
            'parser_info':{'format':'txt','reading_order':'line order',
                           'limitations':['Plain text has no semantic headings, alt text, styling, tables, or metadata']}}

def parse_document(path: str | Path) -> dict[str,Any]:
    """Return engine-ready JSON object; raises ParseError on unsupported/corrupt input.

    The API server should enforce its own upload size and content validation.
    """
    p=Path(path)
    if not p.is_file(): raise ParseError('UNPROCESSABLE_FILE','Document was not found.')
    if p.stat().st_size==0: raise ParseError('UNPROCESSABLE_FILE','Document is empty.')
    extension=p.suffix.lower()
    if extension not in EXTENSIONS: raise ParseError('UNSUPPORTED_FILE_TYPE','Unsupported document type.')
    try:
        if extension=='.docx': result=_docx(p)
        elif extension=='.pdf': result=_pdf(p)
        elif extension in ('.html','.htm'): result=_html(p)
        else: result=_txt(p)
    except ParseError: raise
    except Exception as exc:
        raise ParseError('UNPROCESSABLE_FILE',f'Document could not be parsed: {type(exc).__name__}') from exc
    if not isinstance(result.get('elements'),list): raise ParseError('UNPROCESSABLE_FILE','Invalid parser result.')
    return result
