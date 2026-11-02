import pytest
from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.shared import Inches, RGBColor

from parser import parse_document


@pytest.mark.parametrize('variant', ['first_page', 'even_page'])
@pytest.mark.parametrize('enabled', [False, True])
def test_only_enabled_header_footer_variants_are_read(tmp_path, variant, enabled):
    doc = Document()
    section = doc.sections[0]
    for kind in ('header', 'footer'):
        getattr(section, f'{variant}_{kind}').paragraphs[0].text = f'{variant} {kind}'
    if variant == 'first_page':
        section.different_first_page_header_footer = enabled
    else:
        doc.settings.odd_and_even_pages_header_footer = enabled
    path = tmp_path / 'variants.docx'
    doc.save(path)
    texts = [e.get('text') for e in parse_document(path)['elements']]
    for kind in ('header', 'footer'):
        assert texts.count(f'{variant} {kind}') == int(enabled)


def test_later_section_can_enable_an_inherited_first_page_header(tmp_path):
    doc = Document()
    doc.sections[0].first_page_header.paragraphs[0].text = 'Inherited first-page header'
    doc.sections[0].different_first_page_header_footer = False
    section = doc.add_section(WD_SECTION_START.NEW_PAGE)
    section.different_first_page_header_footer = True
    assert section.first_page_header.is_linked_to_previous
    path = tmp_path / 'inherited.docx'
    doc.save(path)
    matches = [e for e in parse_document(path)['elements']
               if e.get('text') == 'Inherited first-page header']
    assert len(matches) == 1
    assert matches[0]['location']['section'] == 2


@pytest.mark.parametrize('part', ['body', 'header', 'footer'])
def test_word_tables_preserve_cell_headings_colors_and_nested_tables(tmp_path, part):
    doc = Document()
    if part == 'body':
        table = doc.add_table(rows=2, cols=1)
    else:
        table = getattr(doc.sections[0], part).add_table(rows=2, cols=1, width=Inches(4))
    paragraph = table.cell(0, 0).paragraphs[0]
    paragraph.style = 'Heading 3'
    paragraph.add_run('Faint heading').font.color.rgb = RGBColor(170, 170, 170)
    nested = table.cell(1, 0).add_table(rows=1, cols=1)
    nested.cell(0, 0).text = 'Nested text'
    path = tmp_path / 'table.docx'
    doc.save(path)
    elements = parse_document(path)['elements']
    heading = next(e for e in elements if e.get('text') == 'Faint heading')
    assert (heading['type'], heading['level'], heading['color']) == ('heading', 3, '#aaaaaa')
    if part != 'body':
        assert heading['location']['part'] == part
    assert any(e.get('text') == 'Nested text' for e in elements)
    assert len([e for e in elements if e['type'] == 'table']) == 2
    assert any('Faint heading' in row for e in elements if e['type'] == 'table' for row in e['cells'])


@pytest.mark.parametrize('tag', ['p', 'h1', 'a'])
def test_html_preserves_inline_color_overrides_without_duplicate_semantics(tmp_path, tag):
    path = tmp_path / 'mixed.html'
    path.write_text(f'''<html lang="en"><head><title>Test</title><style>
      .faint {{ color: #aaaaaa }}
    </style></head><body><{tag} style="color:#000000">Readable
      <span class="faint">Faint <em>text</em></span>
      readable again</{tag}></body></html>''')
    elements = parse_document(path)['elements']
    faint = [e for e in elements if e.get('color') == '#aaaaaa']
    assert len(faint) == 1 and faint[0]['text'] == 'Faint text'
    assert all(e.get('color') != '#000000' for e in elements if 'Faint' in e.get('text', ''))
    semantic_type = {'p':'text', 'h1':'heading', 'a':'link'}[tag]
    if tag != 'p':
        assert len([e for e in elements if e['type'] == semantic_type]) == 1
    assert len([e for e in elements if e.get('color') == '#000000']) == 2


def test_uniform_inline_markup_keeps_one_paragraph_and_word_boundaries(tmp_path):
    path = tmp_path / 'uniform.html'
    path.write_text('<html><body><p>One<span> two</span><br>three</p></body></html>')
    text = [e for e in parse_document(path)['elements'] if e['type'] == 'text']
    assert len(text) == 1
    assert text[0]['text'] == 'One two three'
    assert text[0]['standalone'] is True
