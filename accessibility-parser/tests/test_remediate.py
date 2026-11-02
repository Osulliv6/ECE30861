"""Automatic remediation (parser/remediate.py). Each repaired file is parsed again to show
the repair is visible to the same parser the engine uses."""
import json
import subprocess
import sys
from pathlib import Path

import pytest
from docx import Document

from parser import ParseError, parse_document
from parser.css import contrast_ratio, parse_color
from parser.remediate import derive_title, relevel, remediate

FIXTURES = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'documents'
BROKEN_HTML = '''<!doctype html><html><head><style>.muted { color: #aaaaaa } .dark { background: #333 } .dark p { color: #555 }</style></head>
<body><h2>Course page</h2><h4>Grading</h4><h3></h3><p class="muted">Due Friday.</p><div class="dark"><p>Dark note</p></div>
<img src="chart.png"><a href="/rubric">click here</a>
<table><tr><td>Item</td><td>Weight</td></tr><tr><td>Exam</td><td>60%</td></tr></table></body></html>'''


def run(tmp_path, name, content=None, **options):
    src = tmp_path / name
    if content is not None:
        src.write_bytes(content if isinstance(content, bytes) else content.encode())
    dst = tmp_path / f'out{src.suffix}'
    return remediate(src, dst, **options), dst


def criteria(changes):
    return [c['wcag_criterion'] for c in changes]


def test_relevel_closes_gaps_and_keeps_shallower_moves():
    assert relevel([2, 4, 4, 2, 5]) == [1, 2, 2, 1, 2]  # sibling H4s stay siblings
    assert relevel([1, 3, 2, 3]) == [1, 2, 2, 3]
    assert relevel([1, 2, 3, 1]) == [1, 2, 3, 1]  # a valid outline is unchanged
    assert relevel([]) == []


def test_derive_title_prefers_h1_then_any_heading_then_text():
    assert derive_title({'elements': [{'type': 'text', 'text': 'Intro'}, {'type': 'heading', 'level': 2, 'text': 'Sub'},
                                      {'type': 'heading', 'level': 1, 'text': 'Main'}]}) == 'Main'
    assert derive_title({'elements': [{'type': 'text', 'text': 'Intro'}, {'type': 'heading', 'level': 2, 'text': 'Sub'}]}) == 'Sub'
    long = 'word ' * 40
    assert len(derive_title({'elements': [{'type': 'text', 'text': long}]})) <= 81
    assert derive_title({'elements': []}) is None


def test_html_repairs_everything_mechanical_and_leaves_judgment_calls(tmp_path):
    result, dst = run(tmp_path, 'page.html', BROKEN_HTML, language='en-US')
    assert sorted(criteria(result['changes'])) == ['1.3.1', '1.3.1', '1.3.1', '1.4.3', '1.4.3', '2.4.2', '2.4.6', '3.1.1']
    after = parse_document(dst)
    assert after['metadata']['language'] == 'en-US'
    assert after['metadata']['title'] == 'Course page'
    assert [(e['level'], e['text']) for e in after['elements'] if e['type'] == 'heading'] == [(1, 'Course page'), (2, 'Grading')]
    assert next(e for e in after['elements'] if e['type'] == 'table')['has_header_row'] is True
    for element in after['elements']:
        if 'color' in element:
            bg = parse_color(element.get('background') or '#ffffff')
            assert contrast_ratio(parse_color(element['color']), bg) >= 4.5, element['text']
    # Alt text and link wording need a person: the image and link are unchanged.
    assert next(e for e in after['elements'] if e['type'] == 'image')['alt'] is None
    assert next(e for e in after['elements'] if e['type'] == 'link')['text'] == 'click here'
    html = dst.read_text()
    assert '<style>.muted { color: #aaaaaa }' in html  # the stylesheet itself is untouched
    assert result['after'] == after


def test_user_supplied_language_and_title_do_not_need_review_but_defaults_do(tmp_path):
    page = '<!doctype html><html><body><h1>Lab 3</h1></body></html>'
    supplied, _ = run(tmp_path, 'a.html', page, language='fr', title='Laboratoire 3')
    assert {c['wcag_criterion']: c['needs_review'] for c in supplied['changes']} == {'3.1.1': False, '2.4.2': False}
    assert supplied['after']['metadata'] == {**supplied['after']['metadata'], 'language': 'fr', 'title': 'Laboratoire 3'}
    defaulted, _ = run(tmp_path, 'b.html', page)
    assert {c['wcag_criterion']: c['needs_review'] for c in defaulted['changes']} == {'3.1.1': True, '2.4.2': True}
    assert defaulted['after']['metadata']['language'] == 'en'
    assert defaulted['after']['metadata']['title'] == 'Lab 3'


def test_existing_valid_language_and_title_are_kept(tmp_path):
    page = '<!doctype html><html lang="de"><head><title>Kurs</title></head><body><h1>Kurs</h1></body></html>'
    result, dst = run(tmp_path, 'page.html', page, language='en', title='Other')
    assert result['changes'] == []
    assert parse_document(dst)['metadata']['language'] == 'de'


def test_important_stylesheet_color_gets_an_important_inline_fix(tmp_path):
    page = '<!doctype html><html lang="en"><head><title>T</title><style>p { color: #bbbbbb !important }</style></head><body><p>Faint</p></body></html>'
    result, dst = run(tmp_path, 'page.html', page)
    assert '!important' in dst.read_text()
    text = next(e for e in result['after']['elements'] if e['type'] == 'text')
    assert contrast_ratio(parse_color(text['color']), (255, 255, 255, 1)) >= 4.5


def test_large_text_only_needs_three_to_one(tmp_path):
    page = '<!doctype html><html lang="en"><head><title>T</title></head><body><h1 style="color: #aaaaaa">Big</h1></body></html>'
    result, _ = run(tmp_path, 'page.html', page)
    heading = next(e for e in result['after']['elements'] if e['type'] == 'heading')
    ratio = contrast_ratio(parse_color(heading['color']), (255, 255, 255, 1))
    assert 3 <= ratio < 3.3


def test_docx_repairs_heading_levels_header_row_language_title_and_colors(tmp_path):
    from docx.shared import RGBColor
    doc = Document()
    doc.add_heading('Syllabus', level=1)
    doc.add_heading('Grading', level=3)
    doc.add_heading('', level=2)
    p = doc.add_paragraph()
    p.add_run('Faint text').font.color.rgb = RGBColor(0xBB, 0xBB, 0xBB)
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).text = 'Item'
    src = tmp_path / 'course.docx'
    doc.save(src)
    result, dst = run(tmp_path, 'course.docx', language='en-US')
    assert sorted(criteria(result['changes'])) == ['1.3.1', '1.3.1', '1.4.3', '2.4.2', '2.4.6', '3.1.1']
    after = parse_document(dst)
    assert after['metadata']['language'] == 'en-US' and after['metadata']['title'] == 'Syllabus'
    assert [(e['level'], e['text']) for e in after['elements'] if e['type'] == 'heading'] == [(1, 'Syllabus'), (2, 'Grading')]
    assert next(e for e in after['elements'] if e['type'] == 'table')['has_header_row'] is True
    faint = next(e for e in after['elements'] if e.get('text') == 'Faint text')
    assert contrast_ratio(parse_color(faint['color']), (255, 255, 255, 1)) >= 4.5


def test_docx_fixture_keeps_alt_text_and_links_for_a_person(tmp_path):
    result, _ = run(tmp_path, 'course.docx', (FIXTURES / 'course.docx').read_bytes())
    assert sorted(criteria(result['changes'])) == ['1.3.1', '1.3.1']
    images = [e for e in result['after']['elements'] if e['type'] == 'image']
    assert [i['alt'] for i in images] == [None, 'Bar chart of the grade distribution']


def test_pdf_gets_title_language_and_display_title_but_tags_are_not_invented(tmp_path):
    import pymupdf as fitz
    doc = fitz.open()
    doc.new_page().insert_text((72, 72), 'Lab safety rules', fontsize=12)
    src = tmp_path / 'rules.pdf'
    doc.save(src)
    doc.close()
    result, dst = run(tmp_path, 'rules.pdf', language='en-US')
    assert criteria(result['changes']) == ['3.1.1', '2.4.2']
    after = parse_document(dst)
    assert (after['metadata']['title'], after['metadata']['language'], after['metadata']['tagged']) == ('Lab safety rules', 'en-US', False)
    out = fitz.open(dst)
    assert out.xref_get_key(out.pdf_catalog(), 'ViewerPreferences/DisplayDocTitle') == ('bool', 'true')


def test_tagged_pdf_keeps_its_tags_after_repair(tmp_path):
    import pymupdf as fitz
    doc = fitz.open(FIXTURES / 'tagged.pdf')
    doc.set_metadata({})
    src = tmp_path / 'tagged.pdf'
    doc.save(src)
    doc.close()
    result, dst = run(tmp_path, 'tagged.pdf')
    assert criteria(result['changes']) == ['2.4.2']
    after = parse_document(dst)
    assert after['metadata']['title'] == 'Course Syllabus' and after['metadata']['tagged'] is True
    assert [e['type'] for e in after['elements']] == [e['type'] for e in parse_document(FIXTURES / 'tagged.pdf')['elements']]


def test_plain_text_is_copied_unchanged(tmp_path):
    result, dst = run(tmp_path, 'notes.txt', (FIXTURES / 'notes.txt').read_bytes())
    assert result['changes'] == []
    assert dst.read_bytes() == (FIXTURES / 'notes.txt').read_bytes()


def test_invalid_inputs_raise_parse_errors(tmp_path):
    with pytest.raises(ParseError) as error:
        run(tmp_path, 'a.html', '<html><body>x</body></html>', language='english!')
    assert error.value.code == 'INVALID_LANGUAGE'
    with pytest.raises(ParseError) as error:
        run(tmp_path, 'corrupt.docx', (FIXTURES / 'corrupt.docx').read_bytes())
    assert error.value.code == 'UNPROCESSABLE_FILE'


def test_cli_remediate_prints_only_json(tmp_path):
    src = tmp_path / 'page.html'
    src.write_text(BROKEN_HTML)
    root = Path(__file__).resolve().parents[1]
    out = subprocess.run([sys.executable, '-m', 'parser.cli', 'remediate', str(src), str(tmp_path / 'fixed.html'),
                          '--title=-dash title'], cwd=root, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    data = json.loads(out.stdout)
    assert set(data) == {'changes', 'before', 'after'}
    assert data['after']['metadata']['title'] == '-dash title'
