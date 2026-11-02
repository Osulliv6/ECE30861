"""Stylesheet resolution for HTML contrast checks (parser/css.py)."""
import pytest
from bs4 import BeautifulSoup

from parser import parse_document
from parser.css import (StyleResolver, contrast_ratio, fix_contrast, parse_color, parse_rules,
                        required_ratio, specificity)


def styled(css, body, head_extra=''):
    return f'<!doctype html><html lang="en"><head><title>T</title><style>{css}</style>{head_extra}</head><body>{body}</body></html>'


def elements(tmp_path, html):
    path = tmp_path / 'page.html'
    path.write_text(html)
    return parse_document(path)


def by_text(parsed):
    return {e.get('text'): e for e in parsed['elements']}


def test_class_and_type_rules_from_style_element_set_text_color(tmp_path):
    parsed = elements(tmp_path, styled('.muted { color: #aaaaaa } p { color: #333 }',
                                       '<p class="muted">Muted</p><p>Plain</p>'))
    found = by_text(parsed)
    assert found['Muted']['color'] == '#aaaaaa'
    assert found['Plain']['color'] == '#333333'


def test_cascade_order_specificity_important_and_inline(tmp_path):
    css = ('#main p { color: #111111 } p.note { color: #222222 } p { color: #333333 }'
           '.loud { color: #444444 !important } .later { color: #555555 } .later { color: #666666 }')
    body = ('<div id="main"><p class="note">Id wins</p></div><p class="note">Class wins</p>'
            '<p class="note loud" style="color: #000">Important beats inline</p>'
            '<p class="note" style="color: #777777">Inline beats class</p><p class="later">Later wins</p>')
    found = by_text(elements(tmp_path, styled(css, body)))
    assert found['Id wins']['color'] == '#111111'
    assert found['Class wins']['color'] == '#222222'
    assert found['Important beats inline']['color'] == '#444444'
    assert found['Inline beats class']['color'] == '#777777'
    assert found['Later wins']['color'] == '#666666'


def test_color_is_inherited_and_background_comes_from_nearest_ancestor(tmp_path):
    css = 'body { color: #999999 } .panel { background-color: #000080 } .panel .inner { color: #ffff00 }'
    body = '<p>Body text</p><div class="panel"><p>Default on navy</p><div class="inner"><p>Yellow on navy</p></div></div>'
    found = by_text(elements(tmp_path, styled(css, body)))
    assert (found['Body text']['color'], found['Body text'].get('background')) == ('#999999', None)
    assert (found['Default on navy']['color'], found['Default on navy']['background']) == ('#999999', '#000080')
    assert (found['Yellow on navy']['color'], found['Yellow on navy']['background']) == ('#ffff00', '#000080')


def test_semi_transparent_background_is_composited_over_the_one_below(tmp_path):
    css = '.page { background: #ffffff } .overlay { background: rgba(0, 0, 0, 0.5) } .overlay p { color: #fff }'
    found = by_text(elements(tmp_path, styled(css, '<div class="page"><div class="overlay"><p>Over</p></div></div>')))
    assert found['Over']['background'] == '#808080'


def test_unknown_backgrounds_and_colors_skip_contrast_instead_of_guessing(tmp_path):
    css = ('.hero { background: url(hero.png) #000 } .grad { background-image: linear-gradient(red, blue) }'
           '.var { color: var(--brand) }')
    body = ('<div class="hero"><p style="color: #fff">On image</p></div>'
            '<div class="grad"><p>On gradient</p></div><p class="var">Variable</p>')
    found = by_text(elements(tmp_path, styled(css, body)))
    for text in ['On image', 'On gradient', 'Variable']:
        assert 'color' not in found[text], text
        assert found[text]['contrast_unknown'] is True


def test_media_rules_external_sheets_hidden_text_and_dynamic_states(tmp_path):
    css = ('@media print { .a { color: #eeeeee } } @media screen { .b { color: #dddddd } }'
           '@media (max-width: 600px) { .c { color: #cccccc } } .hidden { display: none; color: #eee }'
           'a:hover { color: #eeeeee } @import url(x.css);')
    body = '<p class="a">Print</p><p class="b">Screen</p><p class="c">Narrow</p><p class="hidden">Gone</p><p><a href="/">Link</a></p>'
    parsed = elements(tmp_path, styled(css, body, '<link rel="stylesheet" href="site.css">'))
    found = by_text(parsed)
    assert 'color' not in found['Print']
    assert found['Screen']['color'] == '#dddddd'
    assert 'color' not in found['Narrow']  # conditional media queries are not evaluated
    assert 'color' not in found['Gone']
    assert 'color' not in found['Link']
    assert parsed['metadata']['external_stylesheets'] == 1


def test_font_size_and_weight_from_stylesheets_and_defaults(tmp_path):
    css = 'body { font-size: 20px } .big { font-size: 1.5em } .rem { font-size: 2rem } .w { font-weight: 700 } .n { font-weight: normal }'
    body = '<h1>Title</h1><p class="big">Big</p><p class="rem">Rem</p><p class="w">Bold</p><h2 class="n">Not bold</h2>'
    found = by_text(elements(tmp_path, styled(css, body)))
    assert found['Title']['font_size_pt'] == 30.0 and found['Title']['bold'] is True  # 2em of 20px
    assert found['Big']['font_size_pt'] == 22.5
    assert found['Rem']['font_size_pt'] == 24.0  # rem uses the 16px root default
    assert found['Bold']['bold'] is True
    assert 'bold' not in found['Not bold']


def test_links_now_carry_colors_for_contrast(tmp_path):
    found = by_text(elements(tmp_path, styled('a { color: #bbbbbb }', '<p>See <a href="/x">the syllabus</a></p>')))
    assert found['the syllabus']['color'] == '#bbbbbb'


@pytest.mark.parametrize('value,expected', [
    ('#abc', (170, 187, 204, 1.0)), ('#aabbcc80', (170, 187, 204, 128 / 255)), ('rgb(1, 2, 3)', (1, 2, 3, 1.0)),
    ('rgb(10% 20% 30% / 50%)', (25.5, 51, 76.5, 0.5)), ('hsl(0, 0%, 50%)', (127.5, 127.5, 127.5, 1.0)),
    ('Navy', (0, 0, 128, 1.0)), ('transparent', (0, 0, 0, 0)), ('var(--x)', None), ('nonsense', None)])
def test_parse_color(value, expected):
    assert parse_color(value) == (pytest.approx(expected) if expected else None)


def test_specificity_and_rule_parsing():
    assert specificity('#a .b p') == (1, 1, 1)
    assert specificity('ul li a:visited') == (0, 1, 3)
    assert specificity('p::first-line') == (0, 0, 2)
    assert parse_rules('/* c */ p{color:red} @font-face{font-family:x} @media screen{a{color:blue}}') == [
        ('p', {'color': ('red', False)}), ('a', {'color': ('blue', False)})]


def test_contrast_math_matches_wcag_reference_values_used_by_the_engine():
    white, black = (255, 255, 255, 1), (0, 0, 0, 1)
    assert contrast_ratio(white, black) == pytest.approx(21)
    assert contrast_ratio((118, 118, 118, 1), white) == pytest.approx(4.54, abs=0.01)
    assert required_ratio(18, False) == 3 and required_ratio(14, True) == 3 and required_ratio(14, False) == 4.5


@pytest.mark.parametrize('fg,bg,required', [
    ((170, 170, 170, 1), (255, 255, 255, 1), 4.5), ((85, 85, 85, 1), (51, 51, 51, 1), 4.5),
    ((255, 0, 0, 1), (255, 255, 255, 1), 4.5), ((200, 200, 200, 1), (255, 255, 255, 1), 3.0), ((120, 120, 120, 1), (119, 119, 119, 1), 4.5)])
def test_fix_contrast_meets_the_requirement_with_the_smallest_change(fg, bg, required):
    fixed = fix_contrast(fg, bg, required)
    assert contrast_ratio(fixed, bg) >= required
    assert contrast_ratio(fixed, bg) < required + 0.25  # minimal: barely past the threshold


def test_resolver_ignores_unsupported_selectors():
    soup = BeautifulSoup('<style>p:unknown-pseudo { color: red } p { color: blue }</style><p>x</p>', 'html.parser')
    resolver = StyleResolver(soup)
    assert resolver.skipped_selectors == 1
    assert resolver.text_style(soup.p)['color'] == '#0000ff'
