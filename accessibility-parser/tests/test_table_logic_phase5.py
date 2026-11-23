from bs4 import BeautifulSoup
import pytest
from parser.table_logic import table_semantics

@pytest.mark.parametrize('html,expected', [
    ('<table><tr><td colspan="2">Grades</td></tr><tr><th>Item</th><th>Points</th></tr><tr><td>Quiz</td><td>10</td></tr></table>', (3, True, False)),
    ('<table><thead><tr><th>Item</th><th>Points</th></tr></thead><tbody><tr><td>Quiz</td><td>10</td></tr></tbody></table>', (2, True, False)),
    ('<table><tr><th scope="row">Quiz</th><td>10</td></tr><tr><th scope="row">Exam</th><td>50</td></tr></table>', (2, False, True)),
    ('<table><tr><td>Quiz</td><td>10</td></tr><tr><td>Exam</td><td>50</td></tr></table>', (2, False, False)),
    ('<table><tr><th scope="col">Item</th><td>Points</td></tr><tr><td>Quiz</td><td>10</td></tr></table>', (2, True, False)),
    # Single-column table: one TH is a header row.
    ('<table><tr><th>Assignments</th></tr><tr><td>HW1</td></tr><tr><td>HW2</td></tr></table>', (3, True, False)),
    # Two-way grid with an empty top-left corner cell.
    ('<table><tr><td></td><th>Mon</th><th>Tue</th></tr><tr><th>9am</th><td>Lecture</td><td>Lab</td></tr><tr><th>10am</th><td>Quiz</td><td>Lab</td></tr></table>', (3, True, True)),
    # A non-empty first TD is data, so the row is not a header row.
    ('<table><tr><td>Total</td><th>Mon</th></tr><tr><td>A</td><td>1</td></tr></table>', (2, False, False)),
    # A lone row header is not a column header row.
    ('<table><tr><th scope="row">Total</th></tr><tr><td>A</td></tr></table>', (2, False, False)),
    ('<table><tr><td>Outer <table><tr><th>Inner</th><th>Score</th></tr><tr><td>A</td><td>1</td></tr></table></td></tr><tr><td>Other</td></tr></table>', (2, False, False)),
])
def test_table_semantics(html, expected):
    assert table_semantics(BeautifulSoup(html, 'html.parser').table) == expected

def test_nested_table_has_own_rows():
    soup = BeautifulSoup('<table><tr><td><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></td></tr><tr><td>End</td></tr></table>', 'html.parser')
    assert table_semantics(soup.table) == (2, False, False)
    assert table_semantics(soup.table.table) == (2, True, False)
