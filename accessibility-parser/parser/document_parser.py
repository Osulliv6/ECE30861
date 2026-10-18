"""Parse supported documents into the team's engine input contract.

Only extracts observable structure. It does not assert WCAG violations.
"""
from __future__ import annotations
import html
import io
import json
import re
from pathlib import Path
from typing import Any

SUPPORTED_MIME_TYPES = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/pdf', 'text/html', 'text/plain'
]
EXTENSIONS = {'.docx': SUPPORTED_MIME_TYPES[0], '.pdf': SUPPORTED_MIME_TYPES[1],
              '.html': 'text/html', '.htm': 'text/html', '.txt': 'text/plain'}

class ParseError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code

def _clean(s):
    return re.sub(r'\s+', ' ', s or '').strip()

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

def _docx_paragraph(paragraph, elements, location):
    text = _clean(paragraph.text)
    style = paragraph.style.name if paragraph.style is not None else ''
    match = re.match(r'^Heading\s*([1-6])$', style, re.I)
    if match:
        item = {'type':'heading','level':int(match.group(1)),'text':text,'location':location}
        item.update(_style_from_runs(paragraph.runs)); _add(elements,item)
    elif text:
        item = {'type':'text','text':text,'standalone':True,'location':location}
        item.update(_style_from_runs(paragraph.runs)); _add(elements,item)
    for link_text, href in _docx_links(paragraph):
        _add(elements, {'type':'link','text':link_text,'href':href,'location':location})
    for img in _docx_images(paragraph):
        img['location'] = location
        _add(elements,img)

def _docx(path):
    from docx import Document
    from docx.oxml.ns import qn
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    doc = Document(path)
    props = doc.core_properties
    metadata = {'title': _clean(props.title), 'language':None,
                'author':_clean(props.author), 'format':'docx'}
    # w:lang on default style is more authoritative than guessing from text.
    style = doc.styles['Normal']
    lang = style.element.rPr.find(qn('w:lang')) if style.element.rPr is not None else None
    if lang is not None: metadata['language'] = lang.get(qn('w:val'))
    elements = []
    for index, child in enumerate(doc.element.body.iterchildren(),1):
        location={'line':index}
        if child.tag == qn('w:p'):
            _docx_paragraph(Paragraph(child,doc), elements, location)
        elif child.tag == qn('w:tbl'):
            t=Table(child, doc)
            if not t.rows: continue
            header=any(row._tr.trPr is not None and row._tr.trPr.find(qn('w:tblHeader')) is not None for row in t.rows)
            _add(elements, {'type':'table','rows':len(t.rows),
                            'has_header_row':bool(header), 'has_header_column':False,
                            'layout':False, 'location':location,
                            'cells':[[cell.text for cell in row.cells] for row in t.rows]})
            for row in t.rows:
                for cell in row.cells:
                    for p in cell.paragraphs:
                        for link_text, href in _docx_links(p):
                            _add(elements,{'type':'link','text':link_text,'href':href,'location':location})
                        for img in _docx_images(p):
                            img['location']=location; _add(elements,img)
    return {'metadata':metadata,'elements':elements,
            'parser_info':{'format':'docx','reading_order':'document body order (approximate for floating objects)',
                           'limitations':['DOCX has no stable page numbers without rendering',
                                          'Only explicitly marked Word heading styles and header rows are authoritative']}}

def _html(path):
    from bs4 import BeautifulSoup, NavigableString, Tag
    raw=Path(path).read_text(encoding='utf-8-sig')
    soup=BeautifulSoup(raw, 'html.parser')
    title = _clean(soup.title.get_text(' ',strip=True)) if soup.title else ''
    metadata={'title':title,'language':soup.html.get('lang') if soup.html else None,'format':'html'}
    for unwanted in soup(['script','style','noscript','template']): unwanted.decompose()
    root=soup.body or soup
    elements=[]; counter=[0]
    def loc(tag):
        counter[0]+=1
        out={'line':counter[0]}
        if tag.get('id'): out['selector']='#'+str(tag['id'])
        return out
    def inline_style(tag):
        styles={}
        css=tag.get('style','')
        for key, field in [('color','color'),('background-color','background'),('font-size','font_size_pt')]:
            m=re.search(r'(?:^|;)\s*'+re.escape(key)+r'\s*:\s*([^;]+)',css,re.I)
            if m:
                val=m.group(1).strip()
                if field=='font_size_pt':
                    sz=re.match(r'([\d.]+)(pt|px)', val)
                    if sz: styles[field]=round(float(sz.group(1))*(.75 if sz.group(2)=='px' else 1),2)
                else: styles[field]=val
        if tag.name in ['b','strong'] or re.search(r'font-weight\s*:\s*(bold|[7-9]00)',css,re.I): styles['bold']=True
        return styles
    def walk(tag):
        for node in tag.children:
            if not isinstance(node,Tag): continue
            name=node.name.lower()
            if re.fullmatch(r'h[1-6]',name):
                item={'type':'heading','level':int(name[1]),'text':_clean(node.get_text(' ',strip=True)),'location':loc(node)}
                item.update(inline_style(node)); _add(elements,item)
                # Links/images inside headings still need independent checks.
                walk(node)
            elif name=='img':
                alt=node.get('alt') if node.has_attr('alt') else None
                _add(elements,{'type':'image','alt':alt,'decorative':alt=='',
                               'src':node.get('src'),'location':loc(node)})
            elif name=='a':
                _add(elements,{'type':'link','text':_clean(node.get_text(' ',strip=True)),
                               'href':node.get('href'),'location':loc(node)})
                walk(node)
            elif name=='table':
                rows=node.find_all('tr')
                header_row=bool(rows and rows[0].find('th'))
                header_col=bool(rows and all(r.find('th',recursive=False) is not None for r in rows))
                _add(elements,{'type':'table','rows':len(rows),'has_header_row':header_row,
                               'has_header_column':header_col,'layout':node.get('role')=='presentation',
                               'caption':_clean(node.caption.get_text(' ',strip=True)) if node.caption else '',
                               'location':loc(node)})
                for r in rows:
                    for c in r.find_all(['td','th'],recursive=False): walk(c)
            elif name in ('p','li','blockquote','pre','figcaption'):
                # Avoid double counting nested structural components.
                chunks=[]
                for child in node.children:
                    if isinstance(child,NavigableString): chunks.append(str(child))
                    elif isinstance(child,Tag) and child.name not in ('a','img','table'):
                        chunks.append(child.get_text(' ',strip=True))
                value=_clean(' '.join(chunks))
                if value:
                    item={'type':'text','text':value,'standalone':True,'location':loc(node)}
                    item.update(inline_style(node)); _add(elements,item)
                walk(node)
            else: walk(node)
    walk(root)
    return {'metadata':metadata,'elements':elements,
            'parser_info':{'format':'html','reading_order':'DOM order',
                           'limitations':['External CSS and computed contrast are not evaluated',
                                          'JavaScript-generated document content is not executed']}}

def _pdf(path):
    import pymupdf as fitz
    doc=fitz.open(path)
    if doc.needs_pass: raise ParseError('UNPROCESSABLE_FILE','Password-protected PDFs are not supported.')
    # Heading, table and alt-text semantics are not read from PDF tags; the engine skips those checks.
    metadata={'title':_clean(doc.metadata.get('title')),'language':None,'format':'pdf',
              'not_extracted':['alt_text','headings','tables']}
    try:
        lang=doc.pdf_catalog() and doc.xref_get_key(doc.pdf_catalog(),'Lang')
        if lang and lang[0]=='string': metadata['language']=lang[1].strip('()')
    except Exception: pass
    elements=[]
    for page_index,page in enumerate(doc,1):
        blocks=page.get_text('dict',sort=True)['blocks']
        links=page.get_links()
        for block in blocks:
            location={'page':page_index}
            if block['type']==1:
                # Page image content is observable; alt semantics may be absent even in tagged PDFs.
                _add(elements,{'type':'image','alt':None,'decorative':False,
                               'src':f"page-{page_index}-image-{block.get('number',0)}",'location':location})
                continue
            lines=block.get('lines',[])
            for line in lines:
                spans=line.get('spans',[])
                value=_clean(' '.join(s.get('text','') for s in spans))
                if not value: continue
                style=spans[0]
                item={'type':'text','text':value,'standalone':True,'location':location,
                      'font_size_pt':round(style.get('size',0),2),
                      'bold':'bold' in style.get('font','').lower(),
                      'color':_rgb_from_int(style.get('color'))}
                _add(elements,item)
        # PDF link target rectangles may not cleanly correspond to extracted words.
        for link in links:
            if not link.get('uri'): continue
            rect=link.get('from')
            label=_clean(page.get_textbox(rect)) if rect is not None else ''
            _add(elements,{'type':'link','text':label,'href':link['uri'],'location':{'page':page_index}})
    doc.close()
    return {'metadata':metadata,'elements':elements,
            'parser_info':{'format':'pdf','reading_order':'page order and spatial text sorting (approximate)',
                           'limitations':['PDF heading semantics, tagging, table headers, and alt text are not reliably exposed by this parser',
                                          'Untyped PDF text is not classified as a heading',
                                          'Background colors and OCR of scanned pages are not supported',
                                          'PDF links are appended per page after extracted page content']}}

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
