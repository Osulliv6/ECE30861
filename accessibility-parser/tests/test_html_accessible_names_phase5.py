import pytest
from parser import parse_document


def parse_html(tmp_path, body):
    path = tmp_path / 'accessible_names.html'
    path.write_text('<html lang="en"><body>' + body + '</body></html>')
    return parse_document(path)['elements']


@pytest.mark.parametrize('markup,expected', [
    ('<a href="/home"><img src="home.png" alt="Home"></a>', 'Home'),
    ('<a href="/home"><img src="home.png" aria-label="Go home"></a>', 'Go home'),
    ('<span id="destination">Dashboard</span><a href="/dash" aria-labelledby="destination"><img src="x.png" alt="Icon"></a>', 'Dashboard'),
    ('<a href="/home"><img src="x.png" alt=""></a>', ''),
    ('<a href="/home"><img src="x.png"></a>', ''),
    ('<a href="/home">Visit <img src="x.png" alt="Home"></a>', 'Visit Home'),
    ('<a href="/home" aria-label="Dashboard">Visit <img src="x.png" alt="Home"></a>', 'Dashboard'),
])
def test_image_link_accessible_names(tmp_path, markup, expected):
    links = [e for e in parse_html(tmp_path, markup) if e['type'] == 'link']
    assert len(links) == 1
    assert links[0]['text'] == expected


@pytest.mark.parametrize('markup,expected,decorative', [
    ('<img src="x.png" aria-label="Chart">', 'Chart', False),
    ('<span id="desc">Revenue chart</span><img src="x.png" aria-labelledby="desc">', 'Revenue chart', False),
    ('<span id="a">Sales</span><span id="b">by month</span><img src="x.png" aria-labelledby="a b">', 'Sales by month', False),
    ('<img src="x.png" alt="Old" aria-label="New">', 'New', False),
    ('<img src="x.png" alt="">', '', True),
    ('<img src="x.png">', None, False),
    ('<img src="x.png" alt="" aria-label="Search">', 'Search', False),
])
def test_image_aria_names(tmp_path, markup, expected, decorative):
    images = [e for e in parse_html(tmp_path, markup) if e['type'] == 'image']
    assert len(images) == 1
    assert images[0]['alt'] == expected
    assert images[0]['decorative'] is decorative


@pytest.mark.parametrize('role,layout', [
    ('presentation', True), ('none', True), ('table', False), ('', False),
])
def test_presentation_table_roles(tmp_path, role, layout):
    attr = f' role="{role}"' if role else ''
    tables = [e for e in parse_html(tmp_path, f'<table{attr}><tr><td>Data</td></tr></table>') if e['type'] == 'table']
    assert len(tables) == 1
    assert tables[0]['layout'] is layout
