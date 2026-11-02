from pathlib import Path
import pytest
from docx import Document
from parser import parse_document, ParseError


def test_docx_structure(tmp_path):
    p=tmp_path/'syllabus.docx'; d=Document(); d.core_properties.title='Syllabus'
    d.add_heading('Course syllabus',level=1)
    d.add_paragraph('Course requirements')
    t=d.add_table(rows=2,cols=2); t.cell(0,0).text='Item'; t.cell(0,1).text='Points'
    t.cell(1,0).text='Quiz'; t.cell(1,1).text='10'
    d.save(p)
    parsed=parse_document(p)
    assert parsed['metadata']['title']=='Syllabus'
    assert parsed['elements'][0]['type']=='heading'
    assert parsed['elements'][0]['level']==1
    assert any(e['type']=='table' and e['rows']==2 for e in parsed['elements'])

def test_html_structure(tmp_path):
    p=tmp_path/'test.html'
    p.write_text('''<!doctype html><html lang="en"><head><title>Test</title></head><body>
<h1>Hello</h1><p style="color: #999999; font-size: 12pt">Intro <a href="https://example.org">click here</a></p>
<img src="x.png"><img src="dec.png" alt=""><table><tr><th>Title</th><th>Points</th></tr><tr><td>Quiz</td><td>10</td></tr></table>
</body></html>''')
    data=parse_document(p)
    assert data['metadata']['language']=='en'
    assert data['metadata']['title']=='Test'
    assert [e['type'] for e in data['elements']].count('image')==2
    assert [e['alt'] for e in data['elements'] if e['type']=='image']==[None,'']
    assert any(e['type']=='table' and e['has_header_row'] for e in data['elements'])
    assert any(e['type']=='link' and e['text']=='click here' for e in data['elements'])
    assert any(e['type']=='text' and e.get('color')=='#999999' for e in data['elements'])

def test_html_inherits_inline_text_color_and_respects_nearest_override(tmp_path):
    p = tmp_path/'inherited.html'
    p.write_text('''<!doctype html><html lang="en"><head><title>Test</title></head>
    <body style="color: #aaaaaa"><p>Inherited color</p>
    <div style="color: #111111"><p>Nearest ancestor</p>
    <p style="color: #222222">Local override</p></div></body></html>''')
    elements = parse_document(p)['elements']
    colors = {e['text']: e.get('color') for e in elements if e['type'] == 'text'}
    assert colors == {'Inherited color': '#aaaaaa', 'Nearest ancestor': '#111111', 'Local override': '#222222'}

def test_pdf(tmp_path):
    import pymupdf as fitz
    path=tmp_path/'page.pdf'; doc=fitz.open(); page=doc.new_page()
    page.insert_text((70,70),'Welcome to the course', fontsize=12)
    doc.set_metadata({'title':'Course'}); doc.save(path); doc.close()
    parsed=parse_document(path)
    assert parsed['metadata']['title']=='Course'
    assert any(e['type']=='text' and 'Welcome' in e['text'] for e in parsed['elements'])
    assert all(e['location']['page']==1 for e in parsed['elements'])

def test_txt_and_bad_file(tmp_path):
    p=tmp_path/'notes.txt'; p.write_text('Hello\n\nWorld\n')
    assert len(parse_document(p)['elements'])==2
    empty=tmp_path/'empty.txt';empty.touch()
    with pytest.raises(ParseError) as error:parse_document(empty)
    assert error.value.code=='UNPROCESSABLE_FILE'
    bad=tmp_path/'test.exe';bad.write_text('x')
    with pytest.raises(ParseError) as error:parse_document(bad)
    assert error.value.code=='UNSUPPORTED_FILE_TYPE'

FIXTURES=Path(__file__).resolve().parents[2]/'tests'/'fixtures'/'documents'

def test_docx_images_links_language_and_header_rows(tmp_path):
    parsed=parse_document(FIXTURES/'course.docx')
    assert parsed['metadata']['language']=='en-US'
    images=[e for e in parsed['elements'] if e['type']=='image']
    assert [i['alt'] for i in images]==[None,'Bar chart of the grade distribution']
    assert {'type':'link','text':'click here','href':'https://example.edu/rubric','location':{'line':7}} in parsed['elements']
    table=next(e for e in parsed['elements'] if e['type']=='table')
    assert table['has_header_row'] is False
    # Word's "Repeat as header row" marks a real header.
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    d=Document(); t=d.add_table(rows=2,cols=1)
    tr_pr=t.rows[0]._tr.get_or_add_trPr(); tr_pr.append(OxmlElement('w:tblHeader'))
    p=tmp_path/'header.docx'; d.save(p)
    assert next(e for e in parse_document(p)['elements'] if e['type']=='table')['has_header_row'] is True

def test_unextractable_semantics_are_declared_for_the_engine():
    pdf=parse_document(FIXTURES/'course.pdf')
    assert pdf['metadata']['tagged'] is False
    assert pdf['metadata']['not_extracted']==['alt_text','headings','tables']
    assert pdf['metadata']['language']=='en-US'
    txt=parse_document(FIXTURES/'notes.txt')
    assert set(txt['metadata']['not_extracted'])>={'title','language','headings'}
    assert 'not_extracted' not in parse_document(FIXTURES/'course.docx')['metadata']

def test_corrupt_and_encrypted_documents_raise_parse_errors():
    for name in ['corrupt.docx','encrypted.pdf']:
        with pytest.raises(ParseError) as error: parse_document(FIXTURES/name)
        assert error.value.code=='UNPROCESSABLE_FILE'

def test_cli_stdout_is_only_json():
    import json, subprocess, sys
    root=Path(__file__).resolve().parents[1]
    for name in ['course.pdf','corrupt.docx']:
        out=subprocess.run([sys.executable,'-m','parser.cli',str(FIXTURES/name)],cwd=root,capture_output=True,text=True).stdout
        json.loads(out)  # A library warning on stdout would make this fail.


# ---- Tagged PDF ------------------------------------------------------------------------------

def test_tagged_pdf_headings_figures_and_tables_come_from_the_tags():
    parsed=parse_document(FIXTURES/'tagged.pdf')
    meta=parsed['metadata']
    assert meta['tagged'] is True and 'not_extracted' not in meta
    headings=[(e['level'],e['text'],e['location']['page']) for e in parsed['elements'] if e['type']=='heading']
    assert headings==[(1,'Course Syllabus',1),(3,'Grading',1)]  # H1 via the /RoleMap entry Title1 -> H1
    images=[(e['alt'],e['location']['page']) for e in parsed['elements'] if e['type']=='image']
    assert images==[(None,1),('Bar chart of the grade distribution',2)]
    tables=[(e['rows'],e['has_header_row'],e['location']['page']) for e in parsed['elements'] if e['type']=='table']
    assert tables==[(2,True,1),(2,False,2)]  # header row inside THead; second table has only TD cells
    # Heading text is not also reported as body text (no duplicate "fake heading" candidates).
    assert not any(e['type']=='text' and e['text'] in ('Course Syllabus','Grading') for e in parsed['elements'])


def test_tagged_pdf_without_parent_tree_does_not_claim_headings_are_missing(tmp_path):
    import pymupdf as fitz
    doc=fitz.open(FIXTURES/'tagged.pdf')
    root=int(doc.xref_get_key(doc.pdf_catalog(),'StructTreeRoot')[1].split()[0])
    doc.xref_set_key(root,'ParentTree','null')
    path=tmp_path/'no-parent-tree.pdf'; doc.save(path); doc.close()
    parsed=parse_document(path)
    assert parsed['metadata']['tagged'] is True
    assert parsed['metadata']['not_extracted']==['headings']
    # Figures and tables come from the tag tree itself, so they are still read.
    assert [e['alt'] for e in parsed['elements'] if e['type']=='image']==[None,'Bar chart of the grade distribution']


def test_figure_actual_text_counts_as_a_text_alternative(tmp_path):
    import pymupdf as fitz
    doc=fitz.open(FIXTURES/'tagged.pdf')
    figure=next(x for x in range(1,doc.xref_length()) if doc.xref_get_key(x,'S')==('name','/Figure') and doc.xref_get_key(x,'Alt')[0]=='null')
    doc.xref_set_key(figure,'ActualText',fitz.get_pdf_str('Photo of the lab bench'))
    path=tmp_path/'actual-text.pdf'; doc.save(path); doc.close()
    assert [e['alt'] for e in parse_document(path)['elements'] if e['type']=='image'][0]=='Photo of the lab bench'


def test_structure_tree_cycles_do_not_hang(tmp_path):
    import pymupdf as fitz
    doc=fitz.open(FIXTURES/'tagged.pdf')
    root=int(doc.xref_get_key(doc.pdf_catalog(),'StructTreeRoot')[1].split()[0])
    top=int(doc.xref_get_key(root,'K')[1].strip('[]').split()[0])
    doc.xref_set_key(top,'K',f'[{top} 0 R]')  # the Document element contains itself
    path=tmp_path/'cycle.pdf'; doc.save(path); doc.close()
    assert parse_document(path)['metadata']['tagged'] is True


# ---- DOCX headers and footers ----------------------------------------------------------------

def test_docx_header_footer_content(tmp_path):
    doc = Document()
    doc.add_paragraph('Body text')
    section = doc.sections[0]
    section.header.paragraphs[0].text = 'Header text'
    section.footer.paragraphs[0].text = 'Footer text'
    path = tmp_path / 'header-footer.docx'
    doc.save(path)
    parsed = parse_document(path)
    texts = [e for e in parsed['elements'] if e['type'] == 'text']
    assert any(e['text'] == 'Body text' for e in texts)
    assert any(e['text'] == 'Header text' and e['location']['part'] == 'header' for e in texts)
    assert any(e['text'] == 'Footer text' and e['location']['part'] == 'footer' for e in texts)
    assert len([e for e in texts if e['text'] == 'Header text']) == 1

def test_docx_header_footer_across_sections_no_duplicates(tmp_path):
    from docx.enum.section import WD_SECTION_START
    doc = Document()
    doc.sections[0].header.paragraphs[0].text = 'Shared header'
    doc.add_section(WD_SECTION_START.NEW_PAGE)
    path = tmp_path / 'linked-sections.docx'
    doc.save(path)
    parsed = parse_document(path)
    assert sum(e.get('text') == 'Shared header' for e in parsed['elements']) == 1
