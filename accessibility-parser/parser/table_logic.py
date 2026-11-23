"""Small, dependency-light HTML table semantics helper for the document parser."""

def table_semantics(node):
    """Return (row_count, has_column_header_row, has_row_header_column).

    Nested table rows are excluded from the parent table. Only explicit TH
    markup is considered; text formatting is not a substitute for semantics.
    """
    rows = [row for row in node.find_all('tr') if row.find_parent('table') is node]
    def cells(row):
        return row.find_all(['th', 'td'], recursive=False)
    def column_header(row):
        headings = [cell for cell in cells(row) if cell.name == 'th']
        return bool(headings) and (
            row.find_parent('thead') is not None
            or any(str(h.get('scope', '')).lower() in ('col', 'colgroup') for h in headings)
            or (len(headings) >= 2 and all(c.name == 'th' for c in cells(row)))
        )
    has_header_row = any(column_header(row) for row in rows)
    data_rows = [row for row in rows if any(c.name == 'td' for c in cells(row))]
    has_header_column = bool(data_rows) and all(
        bool(cells(row)) and cells(row)[0].name == 'th'
        and str(cells(row)[0].get('scope', '')).lower() not in ('col', 'colgroup')
        for row in data_rows
    )
    return len(rows), has_header_row, has_header_column
